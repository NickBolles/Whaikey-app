import { sql, type SQL } from "drizzle-orm";
import type { DB } from "@/db";
import { kick } from "@/lib/enrich/kick";
import { TELEMETRY_RETENTION_DAYS } from "@/lib/observability/metrics";

/**
 * Bottle popularity: which catalog bottles people actually look for, so the
 * flavor refresh (in-app web tier and the Codex bulk pass) spends on those
 * first (docs/DATA_SOURCES.md §2.4d).
 *
 *   score = 20·pours + 10·shelf/wishlist rows + 5·scan matches
 *         + 3·search appearances + 1·page opens            (last 90 days)
 *         + 2·retail feeds listing it + 1·has a barcode     (catalog breadth)
 *
 * Search, view and scan signals come from `bottle_popularity_daily`: one row
 * per (bottle, UTC day) with three counters and nothing else — no user,
 * session, IP or query text, so nothing in it can be tied to a person. A
 * single bottle-day contributes at most POPULARITY_DAILY_CAP per counter, so
 * one script hammering one page cannot buy a refresh.
 */

export const POPULARITY_WEIGHTS = {
  pour: 20,
  shelf: 10,
  scan: 5,
  search: 3,
  view: 1,
  retailFeed: 2,
  barcode: 1,
} as const;

/** Telemetry window for the score; the table is swept on the same clock. */
export const POPULARITY_WINDOW_DAYS = TELEMETRY_RETENTION_DAYS;
/** Per bottle per day per counter, before weighting. */
export const POPULARITY_DAILY_CAP = 50;
/** The "top set": the most popular bottles whose legacy profiles may be refreshed. */
export const POPULAR_REFRESH_TOP = 2500;
/** Results of one search counted as appearances (the head of the list is what people pick from). */
export const SEARCH_HITS_COUNTED = 3;

export type BottleSignal = "search" | "view" | "scan";
const COLUMN: Record<BottleSignal, string> = { search: "searches", view: "views", scan: "scans" };

/** Crawlers and link-preview fetchers are not people looking for a bottle. */
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|monitor/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  return !!ua && BOT_UA.test(ua);
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as T[];
}

/**
 * +1 on today's counter for each bottle. Unknown ids are ignored (the insert
 * selects from `bottles`), duplicates count once.
 */
export async function recordBottleSignals(db: DB, bottleIds: string[], signal: BottleSignal, now = new Date()): Promise<number> {
  const ids = [...new Set(bottleIds.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 10);
  if (ids.length === 0) return 0;
  const col = sql.raw(COLUMN[signal]);
  const result = await db.execute(sql`
    INSERT INTO bottle_popularity_daily (bottle_id, day, ${col})
    SELECT b.id, ${utcDay(now)}, 1 FROM bottles b
    WHERE b.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    ON CONFLICT (bottle_id, day) DO UPDATE SET ${col} = bottle_popularity_daily.${col} + 1
    RETURNING bottle_id`);
  return rowsOf(result).length;
}

/**
 * Fire-and-forget form for request handlers: runs after the response (never
 * slows or fails the request), and skips obvious bots.
 */
export function noteBottleSignals(
  db: DB,
  bottleIds: string[],
  signal: BottleSignal,
  userAgent?: string | null,
): void {
  if (bottleIds.length === 0 || isBotUserAgent(userAgent)) return;
  kick(() => recordBottleSignals(db, bottleIds, signal));
}

/**
 * `SELECT bottle_id, popularity` over every signal, for use as a CTE
 * (`WITH pop AS (${popularitySql()})`). Only bottles with a positive score
 * appear.
 */
export function popularitySql(now = new Date()): SQL {
  const since = utcDay(new Date(now.getTime() - POPULARITY_WINDOW_DAYS * 86_400_000));
  const w = POPULARITY_WEIGHTS;
  const cap = POPULARITY_DAILY_CAP;
  return sql`
    SELECT bottle_id, SUM(w)::float8 AS popularity FROM (
      SELECT bottle_id, ${sql.raw(String(w.pour))} AS w FROM pours WHERE created_at >= ${since}::date
      UNION ALL SELECT bottle_id, ${sql.raw(String(w.shelf))} FROM user_bottles WHERE created_at >= ${since}::date
      UNION ALL SELECT bottle_id, ${sql.raw(String(w.retailFeed))} FROM (SELECT DISTINCT bottle_id, source FROM price_history) ph
      UNION ALL SELECT DISTINCT bottle_id, ${sql.raw(String(w.barcode))} FROM bottle_upcs
      UNION ALL SELECT bottle_id,
          LEAST(searches, ${sql.raw(String(cap))}) * ${sql.raw(String(w.search))}
        + LEAST(views, ${sql.raw(String(cap))}) * ${sql.raw(String(w.view))}
        + LEAST(scans, ${sql.raw(String(cap))}) * ${sql.raw(String(w.scan))}
        FROM bottle_popularity_daily WHERE day >= ${since}
    ) s GROUP BY bottle_id HAVING SUM(w) > 0`;
}

/**
 * SQL predicate (over `bottles b`) for "this bottle's untracked legacy
 * profile may be replaced": not a user submission, and no tasting notes at
 * all — the pre-tracking enrich rolled profiles up from (or prompted with)
 * user notes, and nothing user-derived is ever overwritten. Membership of the
 * top set is checked separately.
 */
export const LEGACY_REFRESH_SAFE = sql`(b.status <> 'user_submitted'
  AND NOT EXISTS (SELECT 1 FROM tasting_notes tn JOIN pours po ON po.id = tn.pour_id WHERE po.bottle_id = b.id))`;

export interface PopularBottle {
  id: string;
  name: string;
  popularity: number;
  tier: string | null;
  legacy: boolean;
  searches: number;
  views: number;
  scans: number;
}

/** The top of the popularity ranking with its recent signals, for the admin page. */
export async function topPopularBottles(db: DB, limit = 10, now = new Date()): Promise<PopularBottle[]> {
  const since = utcDay(new Date(now.getTime() - POPULARITY_WINDOW_DAYS * 86_400_000));
  const rows = rowsOf<{
    id: string;
    name: string;
    popularity: number;
    tier: string | null;
    legacy: boolean;
    searches: number;
    views: number;
    scans: number;
  }>(
    await db.execute(sql`
      WITH pop AS (${popularitySql(now)}),
      sig AS (
        SELECT bottle_id, SUM(searches)::int AS searches, SUM(views)::int AS views, SUM(scans)::int AS scans
        FROM bottle_popularity_daily WHERE day >= ${since} GROUP BY bottle_id
      )
      SELECT b.id, b.name, pop.popularity, p.tier,
             (b.flavor_profile IS NOT NULL AND p.bottle_id IS NULL) AS legacy,
             COALESCE(sig.searches, 0) AS searches, COALESCE(sig.views, 0) AS views, COALESCE(sig.scans, 0) AS scans
      FROM pop JOIN bottles b ON b.id = pop.bottle_id
      LEFT JOIN bottle_flavor_provenance p ON p.bottle_id = b.id
      LEFT JOIN sig ON sig.bottle_id = b.id
      ORDER BY pop.popularity DESC, b.id
      LIMIT ${limit}`),
  );
  return rows.map((r) => ({
    ...r,
    popularity: Number(r.popularity),
    legacy: Boolean(r.legacy),
    searches: Number(r.searches),
    views: Number(r.views),
    scans: Number(r.scans),
  }));
}

/** Of these bottle ids, the ones inside the top-N popularity set. */
export async function inPopularTop(db: DB, bottleIds: string[], top = POPULAR_REFRESH_TOP, now = new Date()): Promise<Set<string>> {
  if (bottleIds.length === 0 || top <= 0) return new Set();
  const rows = rowsOf<{ bottle_id: string }>(
    await db.execute(sql`
      WITH pop AS (${popularitySql(now)}),
      ranked AS (
        SELECT pop.bottle_id FROM pop JOIN bottles b ON b.id = pop.bottle_id
        WHERE b.status <> 'user_submitted'
        ORDER BY pop.popularity DESC, pop.bottle_id LIMIT ${top}
      )
      SELECT bottle_id FROM ranked WHERE bottle_id IN (${sql.join(bottleIds.map((id) => sql`${id}`), sql`, `)})`),
  );
  return new Set(rows.map((r) => r.bottle_id));
}

/** Retention: drop tallies past the telemetry window (cron sweep). */
export async function sweepPopularity(db: DB, now = new Date()): Promise<void> {
  const cutoff = utcDay(new Date(now.getTime() - POPULARITY_WINDOW_DAYS * 86_400_000));
  await db.execute(sql`DELETE FROM bottle_popularity_daily WHERE day < ${cutoff}`);
}

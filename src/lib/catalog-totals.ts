/**
 * The passport's denominators, cached (review REL-2.6, WP-21).
 *
 * A badge tier is "how many distinct bottles of X you have met" against "how
 * many verified bottles of X the catalog holds". The second number used to be
 * three GROUP BY scans of the catalog on every profile view and every Home
 * render (discovery reads the passport to rank). It changes only when the
 * verified catalog changes — rarely, and in bulk — so it is computed once and
 * kept in `catalog_totals`.
 *
 * ## The refresh rule
 *
 * 1. **Writers that change the verified catalog refresh explicitly**, after
 *    their transaction commits: the seed (`seedDatabase`), promoting a
 *    submission (`approveSubmission`), and the end of every `pnpm ingest` run.
 * 2. **Everything else is bounded by age.** A reader that finds the cache
 *    empty or older than `CATALOG_TOTALS_MAX_AGE_MS` recomputes it before
 *    answering. That covers the writers that do not call in — catalog
 *    verification (`verify-sold`, the verification queue, source-backed
 *    promotion) and any hand-run SQL — at the cost of a total being up to an
 *    hour behind them. A denominator an hour stale moves a tier threshold by
 *    at most the handful of bottles verified in that hour, and a tier once
 *    stamped is never taken back (src/lib/passport.ts), so the error is at
 *    worst a badge earned an hour late.
 *
 * A refresh replaces every row in one transaction, so a reader sees the old
 * totals or the new ones, never a half-written set. Concurrent refreshes are
 * serialized by a transaction-scoped advisory lock, and a reader that waited
 * on it re-reads the cache before recounting, so a stale cache under load is
 * recounted once rather than once per request.
 */
import { eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles, catalogTotals, type CatalogTotalFamily, type PassportFamily } from "@/db/schema";

/** How stale the cache may be before a read recomputes it. */
export const CATALOG_TOTALS_MAX_AGE_MS = 60 * 60 * 1000;

const LOCK_KEY = "catalog-totals-refresh";

export interface CatalogTotals {
  /** Distinct verified bottles per country, region and style. */
  country: Map<string, number>;
  region: Map<string, number>;
  style: Map<string, number>;
  /** The verified catalog's size. */
  all: number;
  /** When these numbers were computed. */
  refreshedAt: Date;
}

interface TotalRow {
  family: CatalogTotalFamily;
  value: string;
  total: number;
}

function emptyTotals(refreshedAt: Date): CatalogTotals {
  return { country: new Map(), region: new Map(), style: new Map(), all: 0, refreshedAt };
}

function fromRows(rows: TotalRow[], refreshedAt: Date): CatalogTotals {
  const totals = emptyTotals(refreshedAt);
  for (const row of rows) {
    if (row.family === "all") totals.all = row.total;
    else totals[row.family as PassportFamily].set(row.value, row.total);
  }
  return totals;
}

/**
 * Count the verified catalog by country, region and style in one pass —
 * GROUPING SETS rather than three GROUP BYs, so a refresh is one scan of the
 * verified slice (reached through the `(status, …)` indexes) however many
 * families there are. Empty and null values carry no stamp and are skipped,
 * as the passport has always skipped them.
 */
export async function computeCatalogTotals(db: DB): Promise<TotalRow[]> {
  const result = await db
    .select({
      gCountry: sql<number>`grouping(${bottles.country})`,
      gRegion: sql<number>`grouping(${bottles.region})`,
      gCategory: sql<number>`grouping(${bottles.category})`,
      country: bottles.country,
      region: bottles.region,
      category: bottles.category,
      total: sql<number>`count(*)`,
    })
    .from(bottles)
    .where(eq(bottles.status, "verified"))
    .groupBy(sql`grouping sets ((${bottles.country}), (${bottles.region}), (${bottles.category}), ())`);

  const rows: TotalRow[] = [];
  let sawAll = false;
  for (const r of result) {
    // postgres-js returns count(*) as a string; PGlite as a number.
    const total = Number(r.total);
    if (Number(r.gCountry) === 0) {
      if (r.country) rows.push({ family: "country", value: r.country, total });
    } else if (Number(r.gRegion) === 0) {
      if (r.region) rows.push({ family: "region", value: r.region, total });
    } else if (Number(r.gCategory) === 0) {
      if (r.category) rows.push({ family: "style", value: r.category, total });
    } else {
      rows.push({ family: "all", value: "", total });
      sawAll = true;
    }
  }
  // The grand-total set always yields a row, even over no input rows; kept
  // explicit so an empty catalog still leaves a cache that reads as fresh.
  if (!sawAll) rows.push({ family: "all", value: "", total: 0 });
  return rows;
}

async function readCache(db: DB): Promise<CatalogTotals | null> {
  const rows = await db
    .select({
      family: catalogTotals.family,
      value: catalogTotals.value,
      total: catalogTotals.total,
      refreshedAt: catalogTotals.refreshedAt,
    })
    .from(catalogTotals);
  if (rows.length === 0) return null;
  const refreshedAt = rows.reduce((oldest, r) => (r.refreshedAt < oldest ? r.refreshedAt : oldest), rows[0].refreshedAt);
  return fromRows(rows, refreshedAt);
}

function isFresh(cache: CatalogTotals | null, now: Date): cache is CatalogTotals {
  return cache !== null && now.getTime() - cache.refreshedAt.getTime() <= CATALOG_TOTALS_MAX_AGE_MS;
}

/**
 * Recompute and store the totals. Writers that change the verified catalog
 * call this after they commit — see the refresh rule above.
 *
 * `onlyIfStale` is the reader's path: having waited for the lock, it looks
 * again and takes the numbers a concurrent refresh just wrote rather than
 * computing them a second time, so an expiring cache under load costs one
 * recount, not one per request.
 */
export async function refreshCatalogTotals(
  db: DB,
  now: Date = new Date(),
  { onlyIfStale = false }: { onlyIfStale?: boolean } = {},
): Promise<CatalogTotals> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
    if (onlyIfStale) {
      const cache = await readCache(tx);
      if (isFresh(cache, now)) return cache;
    }
    const rows = await computeCatalogTotals(tx);
    await tx.delete(catalogTotals);
    const values = rows.map((r) => ({ ...r, refreshedAt: now }));
    for (let i = 0; i < values.length; i += 500) {
      await tx.insert(catalogTotals).values(values.slice(i, i + 500));
    }
    return fromRows(rows, now);
  });
}

/**
 * The cached totals, recomputed first when the cache is empty or older than
 * `CATALOG_TOTALS_MAX_AGE_MS`. This is the read every passport number goes
 * through.
 */
export async function getCatalogTotals(db: DB, now: Date = new Date()): Promise<CatalogTotals> {
  const cache = await readCache(db);
  if (isFresh(cache, now)) return cache;
  return refreshCatalogTotals(db, now, { onlyIfStale: true });
}

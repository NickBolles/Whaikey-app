import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { DB } from "@/db";
import {
  bottleAliases,
  bottles,
  distilleries,
  pairings,
  pours,
  userBottles,
  type Bottle,
  type Distillery,
  type Pairing,
  type UserBottle,
  type WhiskeyCategory,
} from "@/db/schema";

export interface BottleSearchResult {
  id: string;
  name: string;
  category: WhiskeyCategory;
  distillery: string | null;
  region: string | null;
  ageYears: number | null;
  abv: number | null;
  avgPrice: number | null;
  flavorProfile: Record<string, number> | null;
}

export interface SearchOptions {
  category?: WhiskeyCategory;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
/** How many candidates we pull from SQL before ranking in JS. */
const CANDIDATE_LIMIT = 100;
/** Prefix length used by the typo-tolerance fallback. */
const PREFIX_LEN = 4;

/** Escape LIKE wildcards so user input is treated literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const resultColumns = {
  id: bottles.id,
  name: bottles.name,
  category: bottles.category,
  distillery: distilleries.name,
  region: bottles.region,
  ageYears: bottles.ageYears,
  abv: bottles.abv,
  avgPrice: bottles.avgPrice,
  flavorProfile: bottles.flavorProfile,
};

/**
 * A token matches a bottle when it appears (case-insensitively) in the bottle
 * name, the distillery name, or any of the bottle's aliases. Postgres LIKE is
 * case-sensitive, so we use ILIKE to keep the search case-insensitive.
 */
function tokenCondition(token: string): SQL {
  const pattern = `%${escapeLike(token)}%`;
  return sql`(
    ${bottles.name} ILIKE ${pattern} ESCAPE '\\'
    OR COALESCE(${distilleries.name}, '') ILIKE ${pattern} ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM ${bottleAliases}
      WHERE ${bottleAliases.bottleId} = ${bottles.id}
        AND ${bottleAliases.alias} ILIKE ${pattern} ESCAPE '\\'
    )
  )`;
}

async function fetchCandidates(
  db: DB,
  tokens: string[],
  category?: WhiskeyCategory,
): Promise<BottleSearchResult[]> {
  const conditions: SQL[] = tokens.map(tokenCondition);
  if (category) conditions.push(eq(bottles.category, category));
  return db
    .select(resultColumns)
    .from(bottles)
    .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id))
    .where(and(...conditions))
    .orderBy(asc(bottles.name))
    .limit(CANDIDATE_LIMIT);
}

/**
 * Rank buckets: exact name match (0), name starts with the query (1), name
 * contains the query as a substring (2), everything else — alias or
 * distillery hits, or tokens spread across fields (3).
 */
function rankOf(name: string, q: string): number {
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

/**
 * Search the public bottle catalog.
 *
 * - Case-insensitive substring match against bottle name, distillery name and
 *   bottle aliases (so "ECBP" finds Elijah Craig Barrel Proof).
 * - Tolerant token matching: the query is split on whitespace and every token
 *   must match somewhere, so "eagle 10" finds "Eagle Rare 10".
 * - Typo tolerance (best effort): if a query yields zero results, we retry
 *   with each token trimmed to its first 4 characters, so trailing-character
 *   typos like "lagavulinn" still surface Lagavulin. Limitation: this only
 *   recovers typos occurring AFTER the 4th character — a typo inside the
 *   first 4 characters (e.g. "lafroig" for Laphroaig, prefix "lafr") only
 *   matches when an alias happens to share that prefix. Real fuzzy matching
 *   (edit distance / trigrams) is out of scope for SQLite LIKE.
 * - Ranking: exact-name matches first, then startsWith, then contains, then
 *   alias/distillery-only matches; ties break alphabetically.
 *
 * An empty/blank query returns "popular" bottles (alphabetical, limited) so
 * the search page has content before the user types. No auth required.
 */
export async function searchBottles(
  db: DB,
  query: string,
  opts: SearchOptions = {},
): Promise<BottleSearchResult[]> {
  const { category, limit = DEFAULT_LIMIT } = opts;
  const q = query.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return db
      .select(resultColumns)
      .from(bottles)
      .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id))
      .where(category ? eq(bottles.category, category) : undefined)
      .orderBy(asc(bottles.name))
      .limit(limit);
  }

  let rows = await fetchCandidates(db, tokens, category);

  if (rows.length === 0) {
    const trimmed = tokens.map((t) => t.slice(0, PREFIX_LEN));
    if (trimmed.some((t, i) => t !== tokens[i])) {
      rows = await fetchCandidates(db, trimmed, category);
    }
  }

  return rows
    .map((row) => ({ row, rank: rankOf(row.name, q) }))
    .sort((a, b) => a.rank - b.rank || a.row.name.localeCompare(b.row.name))
    .slice(0, limit)
    .map((r) => r.row);
}

export interface BottleDetail {
  bottle: Bottle;
  distillery: Distillery | null;
  communityStats: {
    /** Average pour rating across ALL users, null when nobody has rated. */
    avgRating: number | null;
    /** Number of rated pours across all users. */
    ratingCount: number;
  };
  /** The signed-in user's shelf row for this bottle, null when absent/signed out. */
  userBottle: UserBottle | null;
  pairings: Pairing[];
}

/**
 * Everything the bottle detail surface needs in one call: the bottle +
 * distillery, community rating stats aggregated over every user's pours, the
 * current user's shelf relationship (when a userId is given), and pairing
 * suggestions. Returns null for an unknown bottle id.
 */
export async function getBottleDetail(
  db: DB,
  bottleId: string,
  userId?: string,
): Promise<BottleDetail | null> {
  const [row] = await db
    .select({ bottle: bottles, distillery: distilleries })
    .from(bottles)
    .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id))
    .where(eq(bottles.id, bottleId))
    .limit(1);
  if (!row) return null;

  const [stats] = await db
    .select({
      avgRating: sql<number | null>`avg(${pours.rating})`,
      ratingCount: sql<number>`count(${pours.rating})`,
    })
    .from(pours)
    .where(eq(pours.bottleId, bottleId));

  const pairingRows = await db
    .select()
    .from(pairings)
    .where(eq(pairings.bottleId, bottleId))
    .orderBy(asc(pairings.pairingType), asc(pairings.createdAt));

  let userBottle: UserBottle | null = null;
  if (userId) {
    const [ub] = await db
      .select()
      .from(userBottles)
      .where(and(eq(userBottles.userId, userId), eq(userBottles.bottleId, bottleId)))
      .limit(1);
    userBottle = ub ?? null;
  }

  return {
    bottle: row.bottle,
    distillery: row.distillery,
    communityStats: {
      avgRating: stats?.avgRating ?? null,
      ratingCount: stats?.ratingCount ?? 0,
    },
    userBottle,
    pairings: pairingRows,
  };
}

import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { DB } from "@/db";
import {
  bottleAliases,
  bottleClaims,
  bottleMedia,
  bottleResources,
  bottles,
  catalogSources,
  distilleries,
  pairings,
  pours,
  userBottles,
  userProfiles,
  type Bottle,
  type BottleClaim,
  type BottleMedia,
  type BottleResource,
  type CatalogFetchPolicy,
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
  // `resultColumns` has always selected the country; declaring it lets the
  // callers that want the full origin (a bottle's country stamp) reach it.
  country: string | null;
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
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const resultColumns = {
  id: bottles.id,
  name: bottles.name,
  category: bottles.category,
  distillery: distilleries.name,
  country: bottles.country,
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
 *   (edit distance / trigrams) is out of scope for this substring-search path.
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
  communityStats: CommunityRating;
  /** The signed-in user's shelf row for this bottle, null when absent/signed out. */
  userBottle: UserBottle | null;
  pairings: Pairing[];
  resources: Array<
    BottleResource & {
      source: {
        id: string;
        name: string;
        kind: "official" | "editorial" | "retailer" | "registry";
        attribution: string | null;
        fetchPolicy: CatalogFetchPolicy;
      };
    }
  >;
  claims: BottleClaim[];
  media: BottleMedia[];
}

/**
 * Everything the bottle detail surface needs in one call: the bottle +
 * distillery, community rating stats aggregated over every user's pours, the
 * current user's shelf relationship (when a userId is given), and pairing
 * suggestions. Returns null for an unknown bottle id.
 */
export interface CommunityRating {
  /**
   * Mean of the ratings people chose to make public, null when there are too
   * few of them to be an average rather than a disclosure.
   */
  avgRating: number | null;
  /** Public rated pours behind that average. */
  ratingCount: number;
  /** Distinct people behind it — what the floor is actually applied to. */
  raterCount: number;
}

/**
 * Below this many distinct raters, an "average" is one or two people's private
 * business wearing a plural. `/api/bottles/[id]` needs no session, so on a
 * rarely-rated bottle the number moving told an unauthenticated poller the
 * rating and the timing of a single pour.
 */
export const MIN_COMMUNITY_RATERS = 3;

/**
 * The community rating for a bottle, over pours whose owners chose to publish
 * them (review SEC-M2).
 *
 * Two filters and a floor, and all three matter. `visibility = 'public'` is the
 * user's own choice — a pour marked "Only me" never moves a public number, which
 * is the private-by-default promise in docs/SOCIAL.md. `socialEnabled` is the
 * step-back switch: someone who has turned social off has withdrawn their public
 * pours with it. And the floor keeps a two-person "average" from being a way to
 * read one person's rating off a public endpoint.
 *
 * The count is of distinct *people*, not rated pours: three pours from one
 * enthusiast are one opinion, and a per-pour floor would let them clear it alone.
 */
export async function getCommunityRating(db: DB, bottleId: string): Promise<CommunityRating> {
  const [stats] = await db
    .select({
      avgRating: sql<number | null>`avg(${pours.rating})`,
      ratingCount: sql<number>`count(${pours.rating})`,
      raterCount: sql<number>`count(distinct ${pours.userId})`,
    })
    .from(pours)
    .innerJoin(userProfiles, eq(userProfiles.userId, pours.userId))
    .where(
      and(
        eq(pours.bottleId, bottleId),
        eq(pours.visibility, "public"),
        eq(userProfiles.socialEnabled, true),
        sql`${pours.rating} is not null`,
      ),
    );

  const ratingCount = Number(stats?.ratingCount ?? 0);
  const raterCount = Number(stats?.raterCount ?? 0);
  if (raterCount < MIN_COMMUNITY_RATERS) {
    return { avgRating: null, ratingCount, raterCount };
  }
  return {
    avgRating: stats?.avgRating != null ? Number(stats.avgRating) : null,
    ratingCount,
    raterCount,
  };
}

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

  const communityStats = await getCommunityRating(db, bottleId);

  const pairingRows = await db
    .select()
    .from(pairings)
    .where(eq(pairings.bottleId, bottleId))
    .orderBy(asc(pairings.pairingType), asc(pairings.createdAt));

  const resourceRows = await db
    .select({
      resource: bottleResources,
      sourceId: catalogSources.id,
      sourceName: catalogSources.name,
      sourceKind: catalogSources.kind,
      sourceAttribution: catalogSources.attribution,
      sourceFetchPolicy: catalogSources.fetchPolicy,
    })
    .from(bottleResources)
    .innerJoin(catalogSources, eq(bottleResources.sourceId, catalogSources.id))
    .where(and(eq(bottleResources.bottleId, bottleId), eq(catalogSources.enabled, true)))
    .orderBy(asc(bottleResources.resourceType), asc(bottleResources.title));

  // Public detail responses expose compact factual claims, not source-owned
  // description/review prose. Enrichment reads the private claim table directly.
  const claimRows = await db
    .select({ claim: bottleClaims })
    .from(bottleClaims)
    .innerJoin(bottleResources, eq(bottleClaims.resourceId, bottleResources.id))
    .innerJoin(catalogSources, eq(bottleResources.sourceId, catalogSources.id))
    .where(and(
      eq(bottleClaims.bottleId, bottleId),
      ne(bottleClaims.field, "description"),
      inArray(bottleClaims.status, ["accepted", "corroborating"]),
      eq(catalogSources.enabled, true),
    ))
    .orderBy(asc(bottleClaims.field), asc(bottleClaims.createdAt));

  const mediaRows = await db
    .select({ media: bottleMedia })
    .from(bottleMedia)
    .innerJoin(bottleResources, eq(bottleMedia.resourceId, bottleResources.id))
    .innerJoin(catalogSources, eq(bottleResources.sourceId, catalogSources.id))
    .where(and(
      eq(bottleMedia.bottleId, bottleId),
      eq(bottleMedia.rights, "display_remote"),
      eq(catalogSources.enabled, true),
      sql<boolean>`NOT EXISTS (
        SELECT 1
        FROM bottle_media AS restricted_media
        INNER JOIN bottle_resources AS restricted_resource ON restricted_media.resource_id = restricted_resource.id
        INNER JOIN catalog_sources AS restricted_source ON restricted_resource.source_id = restricted_source.id
        WHERE restricted_media.bottle_id = ${bottleMedia.bottleId}
          AND restricted_media.url = ${bottleMedia.url}
          AND restricted_media.rights <> 'display_remote'
          AND restricted_source.enabled = true
      )`,
    ))
    .orderBy(asc(bottleMedia.kind), asc(bottleMedia.createdAt));

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
    communityStats,
    userBottle,
    pairings: pairingRows,
    resources: resourceRows.map((row) => ({
      ...row.resource,
      source: {
        id: row.sourceId,
        name: row.sourceName,
        kind: row.sourceKind,
        attribution: row.sourceAttribution,
        fetchPolicy: row.sourceFetchPolicy,
      },
    })),
    claims: claimRows.map((row) => row.claim),
    media: mediaRows.map((row) => row.media),
  };
}

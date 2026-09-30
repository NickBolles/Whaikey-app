import { and, asc, desc, eq, inArray, ne, notInArray, sql, type SQL } from "drizzle-orm";
import type { DB } from "@/db";
import { catalogVisibleTo } from "@/lib/catalog-visibility";
import {
  bottleAliases,
  bottleClaims,
  bottleMedia,
  bottleResources,
  bottles,
  catalogSearchKey,
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
  /**
   * Who is searching. A user-submitted bottle is visible to its submitter and
   * to nobody else (review PLAN-A1), so an omitted viewer searches the shared
   * catalog only — which is the right default for a signed-out request.
   */
  viewerId?: string;
}

const DEFAULT_LIMIT = 20;
/** How many exact-pass candidates we pull from SQL before the final sort. */
const CANDIDATE_LIMIT = 100;
/**
 * The typo fallback runs only when the exact pass cannot fill this many
 * results. Five, because that is what the evaluation set scores (Recall@5 —
 * src/lib/search.eval.ts) and roughly what fits above the keyboard: when five
 * real hits exist, a misspelling is not what is standing between the user and
 * their bottle, and a second round trip on every keystroke buys nothing.
 */
const FUZZY_TRIGGER = 5;
/**
 * `word_similarity` floor for a token to count as a fuzzy hit. Similarity is
 * shared trigrams over all trigrams, so one dropped letter in a short name
 * costs a lot: "arbeg" against "ardbeg" is 4/9 = 0.44. Swept against the
 * evaluation set and a held-out list: 0.5 loses "arbeg 10", 0.3 starts
 * answering "vodka" with Seagram's V.O.; 0.4 keeps both right. Re-run
 * `pnpm tsx src/lib/search.eval.ts` after changing it.
 */
export const FUZZY_THRESHOLD = 0.4;
/** Tokens shorter than this have no trigram worth comparing; they must match exactly. */
const MIN_FUZZY_TOKEN = 3;
/** Original spelling plus at most this many phonetic variants per token. */
const MAX_VARIANTS = 4;
/**
 * A resemblance to the distillery counts for a little less than one to the
 * bottle's own name or alias. Only ever a tie-breaker between fuzzy hits: it
 * is why "yamazakki 12" puts Yamazaki 12 above Hakushu 12, whose distillery is
 * "Suntory (Yamazaki & Hakushu)".
 */
const DISTILLERY_WEIGHT = 0.9;

/** Escape LIKE wildcards so user input is treated literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The query-side twin of `catalogSearchKey` (src/db/schema.ts): lowercase,
 * drop apostrophes, periods and hyphens, collapse whitespace. Both sides have
 * to agree character for character, or "maker's" and "makers" stop meeting.
 */
export function normalizeSearchText(s: string): string {
  return s.toLowerCase().replace(/['’.-]/g, "").replace(/\s+/g, " ").trim();
}

/** Words that follow an age and say nothing a name can match: "12 year old", "16yr". */
const AGE_WORDS = new Set(["y", "yo", "yr", "yrs", "year", "years", "old"]);

/**
 * Split a normalized query into tokens, folding age statements the way people
 * type them onto the way catalogs print them: "10yr" → "10", and "year",
 * "yrs", "yo", "old" are dropped when they follow a number. "Eagle Rare 10 Year"
 * still matches — dropping "year" from a query never loses a hit, while keeping
 * it loses every "Talisker 10" typed as "talisker 10 year".
 */
export function searchTokens(query: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeSearchText(query).split(" ")) {
    if (!raw) continue;
    const age = /^(\d+)(?:y|yo|yr|yrs|year|years)$/.exec(raw);
    if (age) {
      out.push(age[1]);
      continue;
    }
    const prev = out[out.length - 1];
    if (AGE_WORDS.has(raw) && prev !== undefined && (/^\d+$/.test(prev) || AGE_WORDS.has(prev))) continue;
    out.push(raw);
  }
  return out;
}

/**
 * The misspellings trigrams cannot see. Trigram similarity forgives a dropped
 * or doubled letter ("glenfidich", "lagavulinn") but not a respelled sound:
 * "lafroig" shares three trigrams with "laphroaig" (similarity 0.25), while
 * its ph-variant "laphroig" shares seven (0.78). So each fuzzy token is also
 * tried with the few English sound-spellings enthusiasts actually trade —
 * f/ph, y/ie, k/c/ck, doubled letters — and scores its best variant. Query-side
 * only: the catalog is indexed once, as written.
 */
const PHONETIC_SWAPS: Array<[RegExp, string]> = [
  [/ph/g, "f"],
  [/f/g, "ph"],
  [/(.)\1/g, "$1"],
  [/ie/g, "y"],
  [/y/g, "ie"],
  [/ck/g, "k"],
  [/k/g, "c"],
  [/c/g, "k"],
];

export function tokenVariants(token: string): string[] {
  const out = [token];
  for (const [pattern, replacement] of PHONETIC_SWAPS) {
    if (out.length > MAX_VARIANTS) break;
    const variant = token.replace(pattern, replacement);
    if (!out.includes(variant)) out.push(variant);
  }
  return out;
}

/** A token worth comparing by trigram: long enough, and not just an age or a proof. */
function isFuzzyToken(token: string): boolean {
  return token.length >= MIN_FUZZY_TOKEN && /[a-z]/.test(token);
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

const nameKey = catalogSearchKey(bottles.name);
const distilleryKey = catalogSearchKey(distilleries.name);
const aliasKey = catalogSearchKey(bottleAliases.alias);

/**
 * Ids of the bottles a token substring-matches through any of its three doors:
 * the bottle's name, its distillery's name, or one of its aliases.
 *
 * Written as a UNION of three single-table scans rather than one `OR` across a
 * join because that is what lets Postgres use the trigram indexes (REL-6.1): an
 * `OR` spanning `bottles`, `distilleries` and a correlated `EXISTS` can only be
 * evaluated row by row, which was a pass over the whole catalog per keystroke.
 * Every subquery repeats `catalogSearchKey` exactly, for the index to apply.
 *
 * Id sets are consumed as `= ANY(ARRAY(…))` rather than `IN (…)`, here and by
 * the callers. The planner cannot estimate how many rows a trigram match will
 * return and guesses high, and with `IN` it then hash-joins against a
 * sequential scan of the whole bottles table to look up a few hundred ids —
 * measured at 100k bottles, that scan was a third of the query. An array it
 * probes through the primary key (or `bottles_distillery_idx`) one id at a
 * time, which is what a few hundred ids want.
 */
function exactIds(token: string): SQL {
  const pattern = `%${escapeLike(token)}%`;
  return sql`(
    SELECT ${bottles.id} FROM ${bottles} WHERE ${nameKey} LIKE ${pattern} ESCAPE '\\'
    UNION
    SELECT ${bottles.id} FROM ${bottles} WHERE ${bottles.distilleryId} = ANY(ARRAY(
      SELECT ${distilleries.id} FROM ${distilleries} WHERE ${distilleryKey} LIKE ${pattern} ESCAPE '\\'
    ))
    UNION
    SELECT ${bottleAliases.bottleId} FROM ${bottleAliases} WHERE ${aliasKey} LIKE ${pattern} ESCAPE '\\'
  )`;
}

/**
 * The same three doors as a row predicate, for a token too short to carry a
 * trigram ("10", "sr", "jd"): the index cannot narrow on it, so it filters the
 * rows the longer tokens found instead of producing a candidate set of its own.
 */
function exactCondition(token: string): SQL {
  const pattern = `%${escapeLike(token)}%`;
  return sql`(
    ${nameKey} LIKE ${pattern} ESCAPE '\\'
    OR COALESCE(${distilleryKey}, '') LIKE ${pattern} ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM ${bottleAliases}
      WHERE ${bottleAliases.bottleId} = ${bottles.id}
        AND ${aliasKey} LIKE ${pattern} ESCAPE '\\'
    )
  )`;
}

/**
 * Every token must match somewhere. Tokens long enough for the index each
 * produce an id set and the sets are intersected; short tokens filter the
 * result. A query made only of short tokens falls back to filtering rows.
 */
function allTokensMatch(tokens: string[]): SQL {
  const indexed = tokens.filter((t) => t.length >= MIN_FUZZY_TOKEN);
  const filtered = tokens.filter((t) => t.length < MIN_FUZZY_TOKEN);
  const parts: SQL[] = filtered.map(exactCondition);
  if (indexed.length > 0) {
    parts.unshift(sql`${bottles.id} = ANY(ARRAY(${sql.join(indexed.map(exactIds), sql` INTERSECT `)}))`);
  }
  return and(...parts)!;
}

/**
 * Rank buckets: exact name match (0), name starts with the query (1), name
 * contains the query (2), everything else — alias or distillery hits, or tokens
 * spread across fields (3). Computed in SQL so the candidate `LIMIT` keeps the
 * best matches rather than the alphabetically first ones: in a large catalog
 * "glen" has far more than a hundred hits, and cutting those by name before
 * ranking could drop the exact one.
 */
function rankExpr(q: string): SQL<number> {
  const escaped = escapeLike(q);
  return sql<number>`CASE
    WHEN ${nameKey} = ${q} THEN 0
    WHEN ${nameKey} LIKE ${`${escaped}%`} ESCAPE '\\' THEN 1
    WHEN ${nameKey} LIKE ${`%${escaped}%`} ESCAPE '\\' THEN 2
    ELSE 3
  END`;
}

function baseConditions(category: WhiskeyCategory | undefined, viewerId: string | undefined): SQL[] {
  const conditions: SQL[] = [catalogVisibleTo(viewerId)];
  if (category) conditions.push(eq(bottles.category, category));
  return conditions;
}

type Ranked = BottleSearchResult & { score: number };

function stripScore(row: Ranked): BottleSearchResult {
  const out: Partial<Ranked> = { ...row };
  delete out.score;
  return out as BottleSearchResult;
}

async function exactMatches(
  db: DB,
  tokens: string[],
  q: string,
  category?: WhiskeyCategory,
  viewerId?: string,
): Promise<Ranked[]> {
  const rank = rankExpr(q);
  return db
    .select({ ...resultColumns, score: rank })
    .from(bottles)
    .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id))
    .where(and(allTokensMatch(tokens), ...baseConditions(category, viewerId)))
    .orderBy(rank, asc(bottles.name))
    .limit(CANDIDATE_LIMIT);
}

/**
 * The best `word_similarity` any variant of a token reaches against a bottle's
 * name, its distillery or one of its aliases — or 1 when the token is a plain
 * substring of one of them, so a fuzzy result that also contains a token
 * exactly is never scored below one that merely resembles it.
 */
function tokenScore(token: string): SQL {
  const variants = tokenVariants(token);
  const perVariant = variants.map(
    (v) => sql`GREATEST(
      word_similarity(${v}, ${nameKey}),
      ${DISTILLERY_WEIGHT}::float8 * word_similarity(${v}, COALESCE(${distilleryKey}, '')),
      COALESCE((
        SELECT max(word_similarity(${v}, ${aliasKey})) FROM ${bottleAliases}
        WHERE ${bottleAliases.bottleId} = ${bottles.id}
      ), 0)
    )`,
  );
  return sql`GREATEST(CASE WHEN ${exactCondition(token)} THEN 1 ELSE 0 END, ${sql.join(perVariant, sql`, `)})`;
}

/**
 * Ids a token reaches by resemblance: `<%` is pg_trgm's word-similarity
 * operator, true when some run of words in the right-hand text is at least
 * `pg_trgm.word_similarity_threshold` similar to the token — and, unlike the
 * `word_similarity()` function, answerable from the GIN indexes. A token's
 * exact hits are included, so "lafroig 10" can take "10" from a name while
 * "lafroig" resembles the distillery.
 */
function fuzzyIds(token: string): SQL {
  const variants = tokenVariants(token);
  const anyVariant = (key: SQL) => sql.join(variants.map((v) => sql`${v} <% ${key}`), sql` OR `);
  return sql`(
    SELECT ${bottles.id} FROM ${bottles} WHERE ${anyVariant(nameKey)}
    UNION
    SELECT ${bottles.id} FROM ${bottles} WHERE ${bottles.distilleryId} = ANY(ARRAY(
      SELECT ${distilleries.id} FROM ${distilleries} WHERE ${anyVariant(distilleryKey)}
    ))
    UNION
    SELECT ${bottleAliases.bottleId} FROM ${bottleAliases} WHERE ${anyVariant(aliasKey)}
    UNION
    ${exactIds(token)}
  )`;
}

/**
 * The typo pass. Every token long enough to carry trigrams must resemble
 * something (index-assisted through `fuzzyIds`); every shorter token — an age,
 * a proof, "sr" — must still match exactly, because "lagavulin 61" is not a
 * misspelling of anything we can know. Scored by the mean of each token's best
 * similarity and returned below every exact hit.
 *
 * The similarity threshold is a session setting in pg_trgm, so it is set with
 * `set_config(…, true)` — scoped to this transaction, which is what keeps it
 * safe behind a transaction-mode pooler that hands the connection to someone
 * else the moment we commit.
 */
async function fuzzyMatches(
  db: DB,
  tokens: string[],
  exclude: string[],
  limit: number,
  category?: WhiskeyCategory,
  viewerId?: string,
): Promise<Ranked[]> {
  const fuzzy = tokens.filter(isFuzzyToken);
  if (fuzzy.length === 0) return [];
  const strict = tokens.filter((t) => !isFuzzyToken(t));

  const score = sql<number>`((${sql.join(fuzzy.map(tokenScore), sql` + `)}) / ${fuzzy.length}::float8)`;
  const conditions: SQL[] = [
    sql`${bottles.id} = ANY(ARRAY(${sql.join(fuzzy.map(fuzzyIds), sql` INTERSECT `)}))`,
    ...strict.map(exactCondition),
    ...baseConditions(category, viewerId),
  ];
  if (exclude.length > 0) conditions.push(notInArray(bottles.id, exclude));

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(FUZZY_THRESHOLD)}, true)`,
    );
    const rows = await tx
      .select({ ...resultColumns, score })
      .from(bottles)
      .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id))
      .where(and(...conditions))
      .orderBy(desc(score), asc(bottles.name))
      .limit(limit);
    // postgres-js hands float8 back as a number already; PGlite may not.
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  });
}

/**
 * Search the bottle catalog.
 *
 * - **Exact pass.** Case-, apostrophe- and punctuation-insensitive substring
 *   match against bottle name, distillery name and aliases ("ECBP" finds
 *   Elijah Craig Barrel Proof; "makers mark" finds Maker's Mark). The query is
 *   split on whitespace and every token must match somewhere, so "eagle 10"
 *   finds "Eagle Rare 10 Year". Age statements are folded ("16yr", "12 year
 *   old"). Ranked exact name > prefix > contains > alias/distillery/spread, then
 *   alphabetically.
 * - **Typo pass (review REL-6.1, WP-22).** When the exact pass finds fewer
 *   than five bottles, tokens of three or more letters are matched by trigram
 *   word-similarity with a few phonetic variants, so "lafroig", "glenfidich 12"
 *   and "johnny walker blue" resolve. Fuzzy results always rank below exact
 *   ones: a bottle you spelled correctly never loses its place to one that
 *   merely looks like your query.
 * - **Indexes.** Both passes are answered from trigram GIN indexes on the
 *   normalized name, distillery and alias (`catalogSearchKey`), so the cost
 *   follows the number of matches rather than the size of the catalog.
 *
 * Measured by the committed evaluation set in `src/lib/search.eval.ts`.
 *
 * An empty/blank query returns "popular" bottles (alphabetical, limited) so
 * the search page has content before the user types. No auth required.
 */
export async function searchBottles(
  db: DB,
  query: string,
  opts: SearchOptions = {},
): Promise<BottleSearchResult[]> {
  const { category, limit = DEFAULT_LIMIT, viewerId } = opts;
  const tokens = searchTokens(query);

  if (tokens.length === 0) {
    return db
      .select(resultColumns)
      .from(bottles)
      .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id))
      .where(and(...baseConditions(category, viewerId)))
      .orderBy(asc(bottles.name))
      .limit(limit);
  }

  const q = tokens.join(" ");
  const exact = (await exactMatches(db, tokens, q, category, viewerId))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit);

  if (exact.length >= Math.min(limit, FUZZY_TRIGGER)) return exact.map(stripScore);

  const fuzzy = await fuzzyMatches(
    db,
    tokens,
    exact.map((r) => r.id),
    limit - exact.length,
    category,
    viewerId,
  );
  return [...exact, ...fuzzy].map(stripScore);
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
    // The counts go too, not just the average. This endpoint takes no session,
    // so a count that ticks 0 → 1 tells a poller that a particular small group
    // published a rating and roughly when — the same disclosure the floor is
    // there to prevent, one number over. Below the floor there is no community
    // aggregate to report, and that is the honest answer.
    return { avgRating: null, ratingCount: 0, raterCount: 0 };
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
    .where(and(eq(bottles.id, bottleId), catalogVisibleTo(userId)))
    .limit(1);
  // Someone else's pending submission is 404, not 403: an id that resolves to
  // "not yours" still tells you the bottle exists.
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

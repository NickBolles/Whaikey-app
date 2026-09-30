/**
 * Profile-similarity recommendations (FEATURES.md §7, PLAN.md §2.6/§4.6).
 *
 * Two modes over the shared palate model (src/lib/palate.ts):
 *
 *   - "discovery": new bottles the user does NOT already own/try/wishlist,
 *     ranked by cosine similarity to their palate vector and filtered to their
 *     inferred price band, then nudged by a passport-breadth bias (a bottle
 *     that opens a badge they have never held, or completes the next tier of
 *     one they have, rises a little). The "3 bottles for you" surface — it
 *     answers both "will I like this?" and "where have I not been?".
 *   - "tonight": the user's OWN open bottles, ranked by palate match plus a
 *     kill-list bias (nudge nearly-empty bottles up so they get finished before
 *     they oxidize) and a recent-variety bias (nudge down a category they've
 *     poured lately, to encourage range).
 *
 * Everything here is PURE of AI: with no API key the rail still renders real
 * recommendations with a deterministic, history-grounded one-line reason. The
 * AI layer (src/lib/ai/recommend-explain.ts) only enriches those reasons and is
 * cached per (user, bottle, mode). Responsible-drinking guardrail: reasons never
 * urge drinking more or faster — "finish before it fades" is about avoiding
 * waste, never about consumption.
 */
import { and, asc, desc, eq, inArray, isNotNull, ne, notInArray, sql, type SQL } from "drizzle-orm";
import type { DB } from "@/db";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { bottles, distilleries, pours, userBottles, type PassportFamily } from "@/db/schema";
import { catalogVisibleTo } from "@/lib/catalog-visibility";
import { FLAVOR_WHEEL, WEDGE_IDS } from "@/lib/flavor-wheel";
import {
  cosineSimilarity,
  tasteMatchPercent,
  topWedges,
  type PalateProfileResult,
  type PalateVector,
  type PriceBand,
} from "@/lib/palate";
import { getUserPalate, getUserPriceBand } from "@/lib/palate-store";
import { getPassport, type Passport, type PassportBadge } from "@/lib/passport";
import { badgeProgressFor, type BadgeProgress } from "@/lib/passport-progress";
import {
  getTasteTwins,
  getTwinEndorsements,
  type TwinEndorsement,
} from "@/lib/taste-twins";

export interface Recommendation {
  bottleId: string;
  name: string;
  distillery: string | null;
  category: string;
  region: string | null;
  country: string | null;
  ageYears: number | null;
  avgPrice: number | null;
  matchPercent: number | null;
  reason: string;
  /**
   * US-16: this reason names a real person (or counts them) rather than
   * describing the bottle. Set so downstream layers can tell an attributed
   * sentence from a generic one — the AI explanation pass leaves these alone.
   */
  twinAttributed?: boolean;
  fillLevel?: number | null;
  status?: string | null;
  userBottleId?: string | null;
  /**
   * Discovery only: the passport badge this bottle would open or advance
   * (docs/FEATURES.md §11). Absent in "tonight" mode, where every candidate is
   * a bottle already on the user's shelf and therefore already met — no badge
   * can move. Null when the bottle reaches nothing within a tier's reach.
   */
  badgeProgress?: BadgeProgress | null;
}

export type RecMode = "discovery" | "tonight";

export interface RecommendOptions {
  mode: RecMode;
  limit?: number;
}

/**
 * How far down the palate-scored shortlist we look for twin endorsements.
 * Comfortably wider than any rendered list, so an endorsement can promote a
 * bottle that would otherwise have just missed the cut, without turning the
 * lookup into a scan of every scored bottle.
 */
const ENDORSEMENT_LOOKUP_LIMIT = 40;

/**
 * A twin's endorsement is a thumb on the scale, not the scale: enough to lift
 * a bottle past near-neighbours it was already close to, never past one the
 * palate scored materially higher.
 *
 * Additive rather than a multiplier because "tonight" scores are
 * `match + killBias - varietyPenalty` and are never floored at zero the way
 * discovery's candidates are. Scaling a zero score leaves it untouched and
 * scaling a negative one drives it further down, so the boost would silently
 * demote exactly the bottle it was meant to promote. Adding is monotone at
 * every sign.
 */
const TWIN_ENDORSEMENT_BONUS = 0.15;

/**
 * Discovery's breadth thumb on the scale. A bottle that opens a passport badge
 * the drinker has never held, or that completes the next tier of one they do,
 * is lifted a little above near-neighbours the palate scored the same — the
 * rail is "explore, learn" as much as "match" (AGENTS.md §product guardrails).
 *
 * Sized like TWIN_ENDORSEMENT_BONUS and for the same reason: enough to reorder
 * bottles that were already close, never enough to promote one the palate
 * scored materially lower. Additive, so it is monotone at every sign.
 *
 * This axis is breadth, not volume: both bonuses count DISTINCT stamps met, so
 * they saturate — once you have been to Islay, no amount of pouring Islay
 * moves either one again.
 */
export const PASSPORT_NEW_BADGE_BONUS = 0.12;
export const PASSPORT_NEXT_TIER_BONUS = 0.08;

/** The score a badge hook is worth, by how much ground it actually covers. */
export function passportBonus(progress: BadgeProgress | null): number {
  if (!progress) return 0;
  if (progress.heldTier === 0) return PASSPORT_NEW_BADGE_BONUS;
  if (progress.remaining <= 1) return PASSPORT_NEXT_TIER_BONUS;
  return 0;
}

const DISCOVERY_LIMIT = 8;
const TONIGHT_LIMIT = 5;
export const MAX_RECOMMENDATIONS = 12;
/** How many recent pours count toward the "poured this lately" variety bias. */
const RECENT_POUR_WINDOW = 3;
/** Weight of the kill-list bias: an empty bottle gains up to this much score. */
export const KILL_WEIGHT = 0.5;
/** Score subtracted from a bottle whose category was poured very recently. */
export const VARIETY_PENALTY = 0.15;

/** Wedge id -> lowercase adjective that reads well in a sentence. */
const WEDGE_WORDS: Record<string, string> = {
  fruity: "fruity",
  floral: "floral",
  grain: "grainy",
  sweet: "sweet",
  woody: "woody",
  spicy: "spicy",
  peaty: "smoky",
  feinty: "funky",
};
const WEDGE_LABELS: Record<string, string> = Object.fromEntries(
  FLAVOR_WHEEL.map((w) => [w.id, w.label]),
);

function wedgeWord(wedgeId: string): string {
  return WEDGE_WORDS[wedgeId] ?? (WEDGE_LABELS[wedgeId] ?? wedgeId).toLowerCase();
}

/** "smoky and woody" / "smoky, woody and sweet" / "smoky". */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Human "$50–70" for a price band, using only the band's real numbers. */
function formatBand(band: PriceBand): string {
  const round5 = (n: number) => Math.max(0, Math.round(n / 5) * 5);
  const min = round5(band.min);
  const max = round5(band.max);
  if (min === max) return `around $${max}`;
  return `$${min}–${max}`;
}

export interface ReasonContext {
  band: PriceBand | null;
  /** Categories the user poured in their most recent pours (variety signal). */
  recentCategories?: Set<string>;
  /**
   * Bottles the viewer's taste twins rated highly (US-16), keyed by bottle id.
   * Only ever built from pours already visible to this viewer, so a reason can
   * never say more about a twin's pour than the note itself would.
   */
  twinEndorsements?: Map<string, TwinEndorsement>;
}

/**
 * "Someone who tastes like you liked this" — the one reason a drinker can
 * check against a person rather than against a model. Named outright, with
 * the match percentage that earned the mention, because an unattributed
 * "people like you" is exactly the recommendation nobody trusts.
 */
function twinSentence(endorsement: TwinEndorsement): string {
  const { topTwin, twinCount, topTwinRating, minRating } = endorsement;
  if (twinCount > 1) {
    // A threshold, not one endorser's score pinned on all of them: every twin
    // counted here really did rate it at least this highly. Matches the shape
    // docs/SOCIAL.md §7.7 uses — "your two closest palate matches rated it 4.5+".
    return `${twinCount} people who taste like you rated it ${minRating.toFixed(1)}+.`;
  }
  return `@${topTwin.handle}, a ${topTwin.matchPercent}% palate match, rated it ${topTwinRating.toFixed(1)}.`;
}

/**
 * Build the deterministic, history-grounded one-line reason for a rec. Pure:
 * same inputs → same sentence. Never invents prices (only band numbers that are
 * actually present) and never encourages consumption.
 */
export function buildReason(
  mode: RecMode,
  rec: Recommendation,
  palate: PalateVector,
  ctx: ReasonContext,
): string {
  if (mode === "tonight") {
    const fill = rec.fillLevel;
    if (typeof fill === "number" && fill <= 25) {
      return `Only ${fill}% left — a good one to finish before it fades.`;
    }
    if (ctx.recentCategories && ctx.recentCategories.size > 0 && !ctx.recentCategories.has(rec.category)) {
      const base = "A change of pace from what you’ve poured lately";
      return rec.matchPercent != null
        ? `${base} — and a ${rec.matchPercent}% match for your palate.`
        : `${base}.`;
    }
    const tonightEndorsement = ctx.twinEndorsements?.get(rec.bottleId);
    if (tonightEndorsement) return twinSentence(tonightEndorsement);
    const tops = topWedges(palate, 1).map(wedgeWord);
    if (tops.length > 0) {
      const suffix = rec.matchPercent != null ? ` (${rec.matchPercent}% match)` : "";
      return `Right in your ${tops[0]} wheelhouse${suffix}.`;
    }
    return "One of your open bottles, ready when you are.";
  }

  // discovery
  const endorsement = ctx.twinEndorsements?.get(rec.bottleId);
  if (endorsement) return twinSentence(endorsement);

  const tops = topWedges(palate, 2).map(wedgeWord);
  const lead =
    tops.length > 0
      ? `Leans into your taste for ${joinWords(tops)} drams`
      : "A close match for your palate";
  if (ctx.band) {
    return `${lead}, in your usual ${formatBand(ctx.band)} range.`;
  }
  return `${lead}.`;
}

export interface ReasonDetail {
  reason: string;
  /**
   * True when the sentence built above is the twin sentence — i.e. it makes a
   * claim about a named person's rating. In "tonight" mode a low fill level or
   * a change-of-pace pick outranks an endorsement, so the presence of an
   * endorsement in the context is not by itself enough to know.
   */
  twinAttributed: boolean;
}

/**
 * `buildReason` plus whether the sentence it produced carries a twin
 * attribution. Pure, and derived from the same inputs, so callers never have to
 * re-implement the precedence rules above to find out.
 */
export function buildReasonDetail(
  mode: RecMode,
  rec: Recommendation,
  palate: PalateVector,
  ctx: ReasonContext,
): ReasonDetail {
  const reason = buildReason(mode, rec, palate, ctx);
  const endorsement = ctx.twinEndorsements?.get(rec.bottleId);
  return {
    reason,
    twinAttributed: endorsement != null && reason === twinSentence(endorsement),
  };
}

interface ScoredBottle {
  bottleId: string;
  name: string;
  distillery: string | null;
  category: string;
  region: string | null;
  country: string | null;
  ageYears: number | null;
  avgPrice: number | null;
  flavorProfile: Record<string, number> | null;
  score: number;
  fillLevel?: number | null;
  status?: string | null;
  userBottleId?: string | null;
}

/**
 * How many discovery candidates SQL hands back, best pre-endorsement score
 * first (review REL-2.1).
 *
 * The bound is exact, not a heuristic, as long as it is at least
 * ENDORSEMENT_LOOKUP_LIMIT: SQL orders by the same score the loop below would
 * compute — palate cosine plus the passport bonus — and a twin endorsement can
 * only lift a bottle inside the top ENDORSEMENT_LOOKUP_LIMIT. Anything ranked
 * below that is outscored by at least that many bottles whatever the
 * endorsements say, so it can never reach a list of MAX_RECOMMENDATIONS. The
 * margin above 40 only absorbs float ties at the cut.
 */
export const DISCOVERY_CANDIDATE_LIMIT = 100;

/** Wedge ids go into the SQL text as literals; they are constants, and checked. */
const WEDGE_SQL_IDS = WEDGE_IDS.map((id) => {
  if (!/^[a-z]+$/.test(id)) throw new Error(`unexpected wedge id ${id}`);
  return id;
});

/** A bottle's intensity on one wedge, 0 when absent or not a number (as `?? 0` reads it). */
function wedgeValue(id: string): SQL {
  const key = sql.raw(`'${id}'`);
  return sql`(CASE WHEN jsonb_typeof(${bottles.flavorProfile} -> ${key}) = 'number'
    THEN (${bottles.flavorProfile} ->> ${key})::float8 ELSE 0 END)`;
}

/**
 * The passport stamps that would earn a discovery bonus, by family: values the
 * user holds no badge for at all (any unmet stamp opens a badge, so these earn
 * PASSPORT_NEW_BADGE_BONUS), and held values one distinct bottle short of
 * their next tier (PASSPORT_NEXT_TIER_BONUS). Derived with the same
 * `badgeProgressFor` the loop uses, one stamp at a time, so SQL's ordering
 * score cannot drift from the score the loop assigns.
 */
function passportBonusStamps(passport: Passport) {
  const families: Array<[PassportFamily, PassportBadge[]]> = [
    ["country", passport.countries],
    ["region", passport.regions],
    ["style", passport.styles],
  ];
  const out = {} as Record<PassportFamily, { held: string[]; nearTier: string[] }>;
  for (const [family, badges] of families) {
    const held = badges.map((b) => b.value);
    const nearTier = held.filter((value) => {
      const stamp = {
        country: family === "country" ? value : null,
        region: family === "region" ? value : null,
        category: family === "style" ? value : "",
      };
      return passportBonus(badgeProgressFor(passport, stamp)) === PASSPORT_NEXT_TIER_BONUS;
    });
    out[family] = { held, nearTier };
  }
  return out;
}

/**
 * Discovery candidates, filtered, scored and cut in SQL (review REL-2.1).
 *
 * This used to select every visible bottle and filter in JS — price band,
 * profile present, not already on the shelf — which on a COLA-scale catalog
 * was the whole table per Home render. Now:
 *
 * - **The pool is the verified catalog plus the viewer's own submissions** —
 *   the catalog the passport counts against, so the rail can no longer
 *   recommend an unvetted import that no badge denominator includes; and the
 *   submitter's own bottles, which WP-16 promises they see everywhere they
 *   would see any other. `catalogVisibleTo` is the visibility contract and
 *   stays on this read like every other; the status test only removes
 *   imports.
 * - **Filters** — profile present, not on the user's shelf in any relationship,
 *   inside the price band (an unpriced bottle passes, as `priceInBand` has it).
 * - **Order** — cosine similarity to the palate over the eight wedges, plus
 *   the passport bonus, i.e. exactly the score the caller ranks by before
 *   endorsements, then `LIMIT DISCOVERY_CANDIDATE_LIMIT`.
 *
 * The returned `score` is recomputed with `cosineSimilarity` so it is
 * bit-for-bit the number the rest of this module has always used; SQL only
 * chooses which rows come back.
 */
export async function discoveryCandidates(
  db: DB,
  userId: string,
  palate: PalateProfileResult,
  band: PriceBand | null,
  passport: Passport,
  limit: number = DISCOVERY_CANDIDATE_LIMIT,
): Promise<ScoredBottle[]> {
  const weights = WEDGE_SQL_IDS.map((id) => [id, palate.vector[id] ?? 0] as const);
  if (!weights.some(([, w]) => w !== 0)) return [];

  const dot = sql.join(
    weights.filter(([, w]) => w !== 0).map(([id, w]) => sql`${w}::float8 * ${wedgeValue(id)}`),
    sql` + `,
  );
  const magnitude = sql`sqrt(${sql.join(WEDGE_SQL_IDS.map((id) => sql`power(${wedgeValue(id)}, 2)`), sql` + `)})`;
  const palateMagnitude = Math.sqrt(weights.reduce((sum, [, w]) => sum + w * w, 0));

  const stamps = passportBonusStamps(passport);
  // `notInArray`/`inArray` rather than a hand-written list: both render an
  // empty array as the right constant, and a user with no passport has one.
  const unmet = (column: AnyPgColumn, values: string[]) =>
    sql`(${column} IS NOT NULL AND ${notInArray(sql`${column}`, values)})`;
  const near = (column: AnyPgColumn, values: string[]) => inArray(sql`${column}`, values);
  const bonus = sql`(CASE
    WHEN ${unmet(bottles.country, stamps.country.held)} OR ${unmet(bottles.region, stamps.region.held)}
      OR ${unmet(bottles.category, stamps.style.held)} THEN ${PASSPORT_NEW_BADGE_BONUS}::float8
    WHEN ${near(bottles.country, stamps.country.nearTier)} OR ${near(bottles.region, stamps.region.nearTier)}
      OR ${near(bottles.category, stamps.style.nearTier)} THEN ${PASSPORT_NEXT_TIER_BONUS}::float8
    ELSE 0 END)`;

  const conditions: SQL[] = [
    // Discovery recommends from the shared catalog — never somebody else's
    // pending submission (review PLAN-A1).
    catalogVisibleTo(userId),
    ne(bottles.status, "imported"),
    isNotNull(bottles.flavorProfile),
    sql`NOT EXISTS (
      SELECT 1 FROM ${userBottles}
      WHERE ${userBottles.userId} = ${userId} AND ${userBottles.bottleId} = ${bottles.id}
    )`,
    sql`${magnitude} > 0`,
    sql`(${dot}) > 0`,
  ];
  if (band) {
    conditions.push(
      sql`(${bottles.avgPrice} IS NULL OR ${bottles.avgPrice} BETWEEN ${band.min} AND ${band.max})`,
    );
  }

  const orderScore = sql`((${dot}) / (${palateMagnitude}::float8 * ${magnitude}) + ${bonus})`;
  const rows = await db
    .select({
      bottleId: bottles.id,
      name: bottles.name,
      category: bottles.category,
      region: bottles.region,
      country: bottles.country,
      ageYears: bottles.ageYears,
      avgPrice: bottles.avgPrice,
      flavorProfile: bottles.flavorProfile,
      distillery: distilleries.name,
    })
    .from(bottles)
    .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id))
    .where(and(...conditions))
    .orderBy(desc(orderScore), asc(bottles.name))
    .limit(limit);

  const scored: ScoredBottle[] = [];
  for (const b of rows) {
    const score = cosineSimilarity(palate.vector, b.flavorProfile ?? {});
    // `!(score > 0)` rather than `score <= 0`: a non-numeric profile value
    // makes the cosine NaN, which the old filter let through to the sort.
    if (!(score > 0)) continue;
    scored.push({ ...b, score });
  }
  return scored;
}

async function tonightCandidates(
  db: DB,
  userId: string,
  palate: PalateProfileResult,
): Promise<{ candidates: ScoredBottle[]; recentCategories: Set<string> }> {
  const recentPours = await db
    .select({ category: bottles.category })
    .from(pours)
    .innerJoin(bottles, eq(pours.bottleId, bottles.id))
    .where(eq(pours.userId, userId))
    .orderBy(desc(pours.createdAt))
    .limit(RECENT_POUR_WINDOW);
  const recentCategories = new Set(recentPours.map((p) => p.category));

  const rows = await db
    .select({
      userBottleId: userBottles.id,
      fillLevel: userBottles.fillLevel,
      status: userBottles.status,
      bottleId: bottles.id,
      name: bottles.name,
      category: bottles.category,
      region: bottles.region,
      country: bottles.country,
      ageYears: bottles.ageYears,
      avgPrice: bottles.avgPrice,
      flavorProfile: bottles.flavorProfile,
      distillery: distilleries.name,
    })
    .from(userBottles)
    .innerJoin(bottles, eq(userBottles.bottleId, bottles.id))
    .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id))
    .where(and(eq(userBottles.userId, userId), eq(userBottles.status, "open")));

  const candidates: ScoredBottle[] = rows.map((b) => {
    const match = cosineSimilarity(palate.vector, b.flavorProfile ?? {});
    const fill = b.fillLevel;
    const killBias = ((100 - (typeof fill === "number" ? fill : 100)) / 100) * KILL_WEIGHT;
    const varietyPenalty = recentCategories.has(b.category) ? VARIETY_PENALTY : 0;
    return {
      bottleId: b.bottleId,
      name: b.name,
      distillery: b.distillery,
      category: b.category,
      region: b.region,
      country: b.country,
      ageYears: b.ageYears,
      avgPrice: b.avgPrice,
      flavorProfile: b.flavorProfile,
      fillLevel: b.fillLevel,
      status: b.status,
      userBottleId: b.userBottleId,
      score: match + killBias - varietyPenalty,
    };
  });

  return { candidates, recentCategories };
}

/**
 * Rank recommendations for a user. Returns [] when the palate has no signal yet
 * (no pours), so the rail can show an "log a pour" nudge instead of noise. Pure
 * of AI — reasons are deterministic here and only enriched downstream.
 */
export async function recommendBottles(
  db: DB,
  userId: string,
  opts: RecommendOptions,
): Promise<Recommendation[]> {
  const { mode } = opts;
  const limit = Math.min(Math.max(opts.limit ?? (mode === "tonight" ? TONIGHT_LIMIT : DISCOVERY_LIMIT), 1), MAX_RECOMMENDATIONS);

  const palate = await getUserPalate(db, userId);
  if (palate.sampleSize === 0) return [];
  const band = await getUserPriceBand(db, userId);

  let scored: ScoredBottle[];
  let ctx: ReasonContext;
  // Discovery only: which passport badge each candidate would open or advance.
  const badgeProgress = new Map<string, BadgeProgress>();
  if (mode === "tonight") {
    const { candidates, recentCategories } = await tonightCandidates(db, userId, palate);
    scored = candidates;
    ctx = { band, recentCategories };
  } else {
    // Read-only: the rail must never stamp a tier the drinker has not reached.
    // Every candidate here is outside the user's bar, so none of them is
    // already met and the hook is honest about what meeting it would move.
    // Read first, because SQL ranks candidates by the bonus it implies.
    const passport = await getPassport(db, userId);
    scored = await discoveryCandidates(db, userId, palate, band, passport);
    ctx = { band };
    for (const candidate of scored) {
      const progress = badgeProgressFor(passport, candidate);
      if (!progress) continue;
      badgeProgress.set(candidate.bottleId, progress);
      candidate.score += passportBonus(progress);
    }
  }

  // US-16: lean on people who taste like you. Twins are looked up once and
  // their endorsements are read only over the candidates that survived
  // scoring, so the extra query is bounded by the shortlist rather than the
  // catalog. An endorsement lifts a bottle a little and then explains itself
  // in the reason — it never invents a candidate the palate didn't already
  // like, so a friend's rating can reorder the list but not fill it.
  const twins = await getTasteTwins(db, userId);
  let twinEndorsements: Map<string, TwinEndorsement> | undefined;
  if (twins.length > 0) {
    const shortlist = [...scored]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, ENDORSEMENT_LOOKUP_LIMIT);
    twinEndorsements = await getTwinEndorsements(
      db,
      userId,
      shortlist.map((s) => s.bottleId),
      twins,
    );
    for (const candidate of scored) {
      if (twinEndorsements.has(candidate.bottleId)) candidate.score += TWIN_ENDORSEMENT_BONUS;
    }
    ctx = { ...ctx, twinEndorsements };
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return scored.slice(0, limit).map((s) => {
    const rec: Recommendation = {
      bottleId: s.bottleId,
      name: s.name,
      distillery: s.distillery,
      category: s.category,
      region: s.region,
      country: s.country,
      ageYears: s.ageYears,
      avgPrice: s.avgPrice,
      matchPercent: tasteMatchPercent(palate.vector, s.flavorProfile, palate.sampleSize),
      reason: "",
      ...(mode === "tonight"
        ? { fillLevel: s.fillLevel, status: s.status, userBottleId: s.userBottleId }
        : { badgeProgress: badgeProgress.get(s.bottleId) ?? null }),
    };
    const detail = buildReasonDetail(mode, rec, palate.vector, ctx);
    rec.reason = detail.reason;
    if (detail.twinAttributed) rec.twinAttributed = true;
    return rec;
  });
}

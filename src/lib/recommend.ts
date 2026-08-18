/**
 * Profile-similarity recommendations (FEATURES.md §7, PLAN.md §2.6/§4.6).
 *
 * Two modes over the shared palate model (src/lib/palate.ts):
 *
 *   - "discovery": new bottles the user does NOT already own/try/wishlist,
 *     ranked by cosine similarity to their palate vector and filtered to their
 *     inferred price band. The "3 bottles for you" surface.
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
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles, distilleries, pours, userBottles } from "@/db/schema";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import {
  cosineSimilarity,
  tasteMatchPercent,
  topWedges,
  priceInBand,
  type PalateProfileResult,
  type PalateVector,
  type PriceBand,
} from "@/lib/palate";
import { getUserPalate, getUserPriceBand } from "@/lib/palate-store";
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
  ageYears: number | null;
  avgPrice: number | null;
  matchPercent: number | null;
  reason: string;
  fillLevel?: number | null;
  status?: string | null;
  userBottleId?: string | null;
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
 * A twin's endorsement is a thumb on the scale, not the scale. 1.15 can lift a
 * bottle past near-neighbours it was already close to and never past one the
 * palate scored materially higher.
 */
const TWIN_ENDORSEMENT_BOOST = 1.15;

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
  const { topTwin, twinCount, topRating } = endorsement;
  const rating = topRating.toFixed(1);
  if (twinCount > 1) {
    return `@${topTwin.handle} and ${twinCount - 1} other${twinCount > 2 ? "s" : ""} who taste like you rated it ${rating}.`;
  }
  return `@${topTwin.handle}, a ${topTwin.matchPercent}% palate match, rated it ${rating}.`;
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

interface ScoredBottle {
  bottleId: string;
  name: string;
  distillery: string | null;
  category: string;
  region: string | null;
  ageYears: number | null;
  avgPrice: number | null;
  flavorProfile: Record<string, number> | null;
  score: number;
  fillLevel?: number | null;
  status?: string | null;
  userBottleId?: string | null;
}

async function discoveryCandidates(
  db: DB,
  userId: string,
  palate: PalateProfileResult,
  band: PriceBand | null,
): Promise<ScoredBottle[]> {
  const owned = await db
    .select({ bottleId: userBottles.bottleId })
    .from(userBottles)
    .where(eq(userBottles.userId, userId));
  const ownedSet = new Set(owned.map((o) => o.bottleId));

  const rows = await db
    .select({
      bottleId: bottles.id,
      name: bottles.name,
      category: bottles.category,
      region: bottles.region,
      ageYears: bottles.ageYears,
      avgPrice: bottles.avgPrice,
      flavorProfile: bottles.flavorProfile,
      distillery: distilleries.name,
    })
    .from(bottles)
    .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id));

  const scored: ScoredBottle[] = [];
  for (const b of rows) {
    if (ownedSet.has(b.bottleId)) continue;
    if (!b.flavorProfile || Object.keys(b.flavorProfile).length === 0) continue;
    if (!priceInBand(b.avgPrice, band)) continue;
    const score = cosineSimilarity(palate.vector, b.flavorProfile);
    if (score <= 0) continue;
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
  if (mode === "tonight") {
    const { candidates, recentCategories } = await tonightCandidates(db, userId, palate);
    scored = candidates;
    ctx = { band, recentCategories };
  } else {
    scored = await discoveryCandidates(db, userId, palate, band);
    ctx = { band };
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
      if (twinEndorsements.has(candidate.bottleId)) candidate.score *= TWIN_ENDORSEMENT_BOOST;
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
      ageYears: s.ageYears,
      avgPrice: s.avgPrice,
      matchPercent: tasteMatchPercent(palate.vector, s.flavorProfile, palate.sampleSize),
      reason: "",
      ...(mode === "tonight"
        ? { fillLevel: s.fillLevel, status: s.status, userBottleId: s.userBottleId }
        : {}),
    };
    rec.reason = buildReason(mode, rec, palate.vector, ctx);
    return rec;
  });
}

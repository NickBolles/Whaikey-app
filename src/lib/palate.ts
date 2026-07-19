/**
 * The palate model (PLAN.md §4.6, FEATURES.md §5.2) — pure, dependency-free.
 *
 * A user's palate is a weighted flavor-preference vector over the 8 flavor-wheel
 * wedges, accumulated from their pours as (rating × flavor tags × recency decay):
 *
 *   - rating is centered on a neutral midpoint, so bottles rated above neutral
 *     pull the corresponding wedges positive and bottles rated below push them
 *     negative — the vector captures what the user likes, not just what they drank.
 *   - each pour contributes its own flavor signal: the tasting note's leaf tags
 *     rolled up to wedges when present, otherwise the bottle's flavor profile.
 *   - older pours decay on a half-life so the palate tracks the user's current
 *     taste rather than everything they ever poured.
 *
 * The signed vector grounds recommendations and taste-match (cosine similarity
 * vs a bottle's flavor profile); a non-negative display transform renders it as
 * the "palate wheel". Everything here is pure so it can be unit-tested and run
 * from either the server or (via serialized data) the client.
 */
import { WEDGE_IDS, rollUpToWedges } from "@/lib/flavor-wheel";

/** Rating midpoint on the 0.5–5 scale; pours above this read as "liked". */
export const NEUTRAL_RATING = 3;
/** A pour with no rating still carries a mild positive signal (they poured it). */
export const UNRATED_WEIGHT = 0.5;
/** Preference contribution halves every this-many days. */
export const RECENCY_HALF_LIFE_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One pour's worth of palate signal. `flavorTags` are leaf ids → intensity 1-3. */
export interface PalateEntry {
  rating: number | null;
  flavorTags: Record<string, number> | null;
  /** The poured bottle's flavor profile (wedge id → 0-10), used when tags are absent. */
  bottleProfile: Record<string, number> | null;
  createdAt: Date;
}

/** Signed preference weight per wedge id (absent wedges are 0). */
export type PalateVector = Record<string, number>;

export interface PalateProfileResult {
  vector: PalateVector;
  /** Number of entries that carried a usable flavor signal. */
  sampleSize: number;
}

/** 0.5 ^ (ageDays / halfLife); 1 at age 0, never negative. */
export function recencyDecay(createdAt: Date, now: Date, halfLifeDays = RECENCY_HALF_LIFE_DAYS): number {
  const ageDays = Math.max(0, (now.getTime() - createdAt.getTime()) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** The wedge intensities (0-10) a single pour contributes, tags preferred over profile. */
function entryWedgeScores(entry: PalateEntry): Record<string, number> | null {
  if (entry.flavorTags && Object.keys(entry.flavorTags).length > 0) {
    const rolled = rollUpToWedges(entry.flavorTags);
    if (Object.keys(rolled).length > 0) return rolled;
  }
  if (entry.bottleProfile && Object.keys(entry.bottleProfile).length > 0) {
    return entry.bottleProfile;
  }
  return null;
}

function zeroVector(): PalateVector {
  const v: PalateVector = {};
  for (const id of WEDGE_IDS) v[id] = 0;
  return v;
}

/**
 * Compute the palate vector from a set of pour entries. Pure: identical inputs
 * (including `now`) always yield the same result. Entries without any flavor
 * signal (no tags and no bottle profile) are ignored and don't count toward
 * sampleSize.
 */
export function computePalateProfile(entries: PalateEntry[], now: Date): PalateProfileResult {
  const vector = zeroVector();
  let sampleSize = 0;

  for (const entry of entries) {
    const scores = entryWedgeScores(entry);
    if (!scores) continue;
    sampleSize += 1;

    const preference =
      entry.rating == null ? UNRATED_WEIGHT : entry.rating - NEUTRAL_RATING;
    const decay = recencyDecay(entry.createdAt, now);
    const weight = preference * decay;

    for (const wedgeId of WEDGE_IDS) {
      const intensity = scores[wedgeId] ?? 0;
      vector[wedgeId] += weight * (intensity / 10);
    }
  }

  return { vector, sampleSize };
}

/** Cosine similarity of two wedge vectors in [-1, 1]; 0 when either is all-zero. */
export function cosineSimilarity(a: PalateVector, b: PalateVector): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const wedgeId of WEDGE_IDS) {
    const av = a[wedgeId] ?? 0;
    const bv = b[wedgeId] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Taste-match percentage (0-100) between a palate vector and a bottle's flavor
 * profile. Negative cosine (opposite tastes) clamps to 0. Returns null when the
 * palate has no signal yet or the bottle has no profile, so callers can hide
 * the badge rather than show a misleading 0%.
 */
export function tasteMatchPercent(
  palate: PalateVector,
  bottleProfile: Record<string, number> | null | undefined,
  sampleSize: number,
): number | null {
  if (sampleSize <= 0) return null;
  if (!bottleProfile || Object.keys(bottleProfile).length === 0) return null;
  const sim = cosineSimilarity(palate, bottleProfile);
  if (sim <= 0) return 0;
  return Math.round(sim * 100);
}

/**
 * Non-negative, max-normalized wedge scores (0-10) for the palate radar. The
 * signed preference vector is clipped at 0 (we only paint what the user likes)
 * and scaled so the strongest liked wedge reaches 10 — a taste *fingerprint*
 * shape rather than absolute magnitudes. Returns all-zero when there's no
 * positive signal.
 */
export function displayPalateWheel(palate: PalateVector): Record<string, number> {
  const positive: Record<string, number> = {};
  let max = 0;
  for (const wedgeId of WEDGE_IDS) {
    const v = Math.max(0, palate[wedgeId] ?? 0);
    positive[wedgeId] = v;
    if (v > max) max = v;
  }
  const out: Record<string, number> = {};
  for (const wedgeId of WEDGE_IDS) {
    out[wedgeId] = max === 0 ? 0 : Math.round((positive[wedgeId] / max) * 100) / 10;
  }
  return out;
}

/** The wedge ids a user most prefers, strongest first, positive weights only. */
export function topWedges(palate: PalateVector, limit = 3): string[] {
  return WEDGE_IDS.filter((id) => (palate[id] ?? 0) > 0)
    .sort((a, b) => (palate[b] ?? 0) - (palate[a] ?? 0))
    .slice(0, limit);
}

export interface PriceBand {
  min: number;
  max: number;
  median: number;
}

/**
 * Infer a price band from the user's purchase history. The band spans the 25th
 * to 75th percentile of what they've actually paid, widened by 40% on each side
 * so recommendations aren't boxed into a razor-thin range, and floored at 0.
 * Returns null when there are no priced purchases (no band → no price filter).
 */
export function inferPriceBand(prices: Array<number | null | undefined>): PriceBand | null {
  const clean = prices.filter((p): p is number => typeof p === "number" && p > 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;

  const percentile = (p: number) => {
    if (clean.length === 1) return clean[0];
    const idx = (clean.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return clean[lo];
    return clean[lo] + (clean[hi] - clean[lo]) * (idx - lo);
  };

  const p25 = percentile(0.25);
  const p75 = percentile(0.75);
  const median = percentile(0.5);
  return {
    min: Math.max(0, p25 * 0.6),
    max: p75 * 1.4,
    median,
  };
}

/** Whether a price falls inside a band (bottles with unknown price always pass). */
export function priceInBand(price: number | null | undefined, band: PriceBand | null): boolean {
  if (!band) return true;
  if (typeof price !== "number") return true;
  return price >= band.min && price <= band.max;
}

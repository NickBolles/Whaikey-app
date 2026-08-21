/**
 * Passport progress for a bottle the user has NOT met yet: which badge it
 * would open, or which tier of a badge it would move toward
 * (docs/FEATURES.md §11, docs/SOCIAL.md §3.2).
 *
 * This is the "explore new" half of the discovery rail. It answers, per
 * candidate bottle, the question the passport asks: does meeting this one
 * reach somewhere you have not been? The answer is always about DISTINCT
 * things met — a country, a region, a style — so a 15 ml sample of something
 * new counts exactly as much as a bottle, and a second bottle from a place
 * you have already been counts for nothing new toward a badge you already
 * hold. Nothing here can be advanced by pouring more of anything.
 *
 * Pure: `badgeProgressFor` takes a computed passport and a bottle's stamps and
 * returns a display-ready hook, so the shape can be serialized straight into
 * the recommendations API and rendered on the client without importing the DB.
 */

import type { PassportFamily } from "@/db/schema";
import type { Passport, PassportBadge } from "@/lib/passport";
import { PASSPORT_TIER_SPECS, bottlesForTier } from "@/lib/passport-tiers";
import { categoryLabel } from "@/components/category-chip";

/**
 * How close to a tier still reads as reachable. Beyond this the chip would be
 * a chore list rather than a nudge, so the bottle simply shows no hook.
 */
export const MAX_REMAINING_FOR_HOOK = 3;

export interface BadgeProgress {
  family: PassportFamily;
  /** Canonical stamp as stored on bottles: "Japan", "Islay", "bourbon". */
  value: string;
  /** Display name ("Bourbon" for style ids; the value itself otherwise). */
  label: string;
  /** Tier held today; 0 when nothing from this stamp has been met yet. */
  heldTier: number;
  /** The tier meeting this bottle moves toward. */
  targetTier: number;
  targetName: string;
  targetNumeral: string;
  /** Distinct bottles still needed for `targetTier`, this one included. */
  remaining: number;
}

/**
 * Family order when more than one stamp is in reach. A country is the
 * broadest leap, a style the narrowest — so an unmet country outranks an
 * unmet region, which outranks an unmet style.
 */
const FAMILY_RANK: Record<PassportFamily, number> = { country: 0, region: 1, style: 2 };

export interface BottleStamps {
  country: string | null;
  region: string | null;
  category: string;
}

function labelFor(family: PassportFamily, value: string): string {
  return family === "style" ? categoryLabel(value) : value;
}

/**
 * The hook for one stamp, or null when meeting this bottle changes nothing
 * reachable. `badge` is the user's standing in that stamp today — undefined
 * when they have never met anything carrying it.
 */
function progressForStamp(
  family: PassportFamily,
  value: string,
  badge: PassportBadge | undefined,
): BadgeProgress | null {
  const metCount = badge?.metCount ?? 0;
  const catalogTotal = badge?.catalogTotal ?? 0;
  // The next rung this bottle counts toward: the first tier the user's
  // current count has not already cleared. Unmet stamps land on Oak I, which
  // one distinct bottle earns outright.
  const nextSpec = PASSPORT_TIER_SPECS.find((spec) => metCount < bottlesForTier(spec, catalogTotal));
  if (!nextSpec) return null;
  const remaining = bottlesForTier(nextSpec, catalogTotal) - metCount;
  if (remaining > MAX_REMAINING_FOR_HOOK) return null;
  return {
    family,
    value,
    label: labelFor(family, value),
    heldTier: badge?.heldTier ?? 0,
    targetTier: nextSpec.tier,
    targetName: nextSpec.name,
    targetNumeral: nextSpec.numeral,
    remaining,
  };
}

function findBadge(passport: Passport, family: PassportFamily, value: string): PassportBadge | undefined {
  const list =
    family === "country" ? passport.countries : family === "region" ? passport.regions : passport.styles;
  return list.find((b) => b.value === value);
}

/**
 * The single most compelling passport hook for a bottle the user has not met,
 * or null when it opens nothing within reach.
 *
 * Precedence: a stamp the user has never met at all wins — that is the
 * "somewhere new" the passport exists to reward — and among those the broader
 * family goes first. Otherwise the stamp closest to its next tier wins, again
 * broadest-family-first on a tie, so the chip is deterministic for a given
 * passport rather than dependent on row order.
 */
export function badgeProgressFor(passport: Passport, bottle: BottleStamps): BadgeProgress | null {
  const stamps: Array<[PassportFamily, string | null]> = [
    ["country", bottle.country],
    ["region", bottle.region],
    ["style", bottle.category],
  ];

  const hooks: BadgeProgress[] = [];
  for (const [family, value] of stamps) {
    if (!value) continue;
    const hook = progressForStamp(family, value, findBadge(passport, family, value));
    if (hook) hooks.push(hook);
  }
  if (hooks.length === 0) return null;

  hooks.sort((a, b) => {
    const aNew = a.heldTier === 0 ? 0 : 1;
    const bNew = b.heldTier === 0 ? 0 : 1;
    if (aNew !== bNew) return aNew - bNew;
    if (a.remaining !== b.remaining) return a.remaining - b.remaining;
    return FAMILY_RANK[a.family] - FAMILY_RANK[b.family];
  });
  return hooks[0];
}

/**
 * The line the discovery card shows under the badge crest. Named things met,
 * never a quantity poured: "opens the badge" / "earns Silver III" / "2 more to
 * Silver III".
 */
export function badgeProgressCaption(progress: BadgeProgress): string {
  if (progress.heldTier === 0) return "opens the badge";
  if (progress.remaining <= 1) return `earns ${progress.targetName} ${progress.targetNumeral}`;
  return `${progress.remaining} more to ${progress.targetName} ${progress.targetNumeral}`;
}

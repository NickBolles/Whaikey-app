/**
 * The Passport's tier ladder — pure arithmetic, no DB and no schema import, so
 * both the server (src/lib/passport.ts) and client bundles (the badge crests in
 * src/components/passport-badge.tsx, the discovery rail's progress chip) can
 * share one definition of what a tier costs. `src/lib/passport.ts` re-exports
 * everything here, so existing imports keep working.
 *
 * A tier is a share of the CATALOG's distinct bottles carrying the badge's
 * stamp — met 7 of the 24 Islay bottles we stock and you hold whatever tier
 * 29% clears. Percentages keep a 99-bottle Kentucky and a 6-bottle
 * Campbeltown equally fair ladders; the absolute floor per tier keeps a
 * one-bottle country from minting the top tier on day one.
 *
 * Guardrails, checked in review like docs/SOCIAL.md §3.1's bans: the numerator
 * is distinct bottles met — a repeat pour advances nothing, a 15 ml bar sample
 * counts in full — and tiers are untimed and never downgrade.
 */

export interface PassportTierSpec {
  tier: number;
  name: string;
  numeral: string;
  /** Fraction of the badge's catalog bottles required (0 for tier I). */
  pctOfCatalog: number;
  /** Absolute distinct-bottle floor, so tiny catalogs cap early. */
  minBottles: number;
}

export const PASSPORT_TIER_SPECS: readonly PassportTierSpec[] = [
  { tier: 1, name: "Oak", numeral: "I", pctOfCatalog: 0, minBottles: 1 },
  { tier: 2, name: "Copper", numeral: "II", pctOfCatalog: 0.1, minBottles: 3 },
  { tier: 3, name: "Silver", numeral: "III", pctOfCatalog: 0.25, minBottles: 6 },
  { tier: 4, name: "Gold", numeral: "IV", pctOfCatalog: 0.5, minBottles: 12 },
  { tier: 5, name: "Amber", numeral: "V", pctOfCatalog: 0.8, minBottles: 20 },
];

export function tierSpec(tier: number): PassportTierSpec | null {
  return PASSPORT_TIER_SPECS.find((s) => s.tier === tier) ?? null;
}

/** Distinct bottles needed for a tier given the badge's catalog total. */
export function bottlesForTier(spec: PassportTierSpec, catalogTotal: number): number {
  return Math.max(Math.ceil(spec.pctOfCatalog * catalogTotal), spec.minBottles);
}

/**
 * The tier `metCount` distinct bottles earns against a catalog of
 * `catalogTotal`. 0 = no badge (nothing met). The catalog can shrink behind a
 * user (bottle removed) or the numerator can include bottles the denominator
 * filter excludes, so metCount above catalogTotal is tolerated, not an error.
 */
export function tierForCount(metCount: number, catalogTotal: number): number {
  if (metCount <= 0) return 0;
  let earned = 0;
  for (const spec of PASSPORT_TIER_SPECS) {
    if (metCount >= bottlesForTier(spec, catalogTotal)) earned = spec.tier;
  }
  return earned;
}

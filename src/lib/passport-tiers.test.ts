import { describe, expect, it } from "vitest";
import {
  PASSPORT_TIER_SPECS,
  bottlesForTier,
  tierForCount,
  tierSpec,
} from "./passport-tiers";

// The pure ladder, tested at its own module (review REL-8.4). passport.test.ts
// covers the same functions through the DB-backed re-export with a few spot
// values; these are the invariants every catalog size must keep — the
// properties the SOCIAL.md §3.2 guardrails depend on.

const CATALOG_SIZES = [0, 1, 2, 3, 5, 6, 7, 11, 12, 19, 20, 24, 25, 40, 99, 100, 101, 1000];

describe("PASSPORT_TIER_SPECS", () => {
  it("is five tiers, numbered 1…5 in order, with unique names and numerals", () => {
    expect(PASSPORT_TIER_SPECS.map((s) => s.tier)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(PASSPORT_TIER_SPECS.map((s) => s.name)).size).toBe(5);
    expect(PASSPORT_TIER_SPECS.map((s) => s.numeral)).toEqual(["I", "II", "III", "IV", "V"]);
  });

  it("gets strictly harder on both axes, and tier I costs exactly one bottle", () => {
    for (let i = 1; i < PASSPORT_TIER_SPECS.length; i++) {
      expect(PASSPORT_TIER_SPECS[i].pctOfCatalog).toBeGreaterThan(PASSPORT_TIER_SPECS[i - 1].pctOfCatalog);
      expect(PASSPORT_TIER_SPECS[i].minBottles).toBeGreaterThan(PASSPORT_TIER_SPECS[i - 1].minBottles);
    }
    expect(PASSPORT_TIER_SPECS[0]).toMatchObject({ pctOfCatalog: 0, minBottles: 1 });
    // No tier ever asks for more than the whole catalog's share.
    for (const s of PASSPORT_TIER_SPECS) expect(s.pctOfCatalog).toBeLessThanOrEqual(1);
  });
});

describe("tierSpec", () => {
  it("looks up by tier number and returns null outside the ladder", () => {
    expect(tierSpec(3)?.name).toBe("Silver");
    expect(tierSpec(0)).toBeNull();
    expect(tierSpec(6)).toBeNull();
    expect(tierSpec(2.5)).toBeNull();
  });
});

describe("bottlesForTier", () => {
  it("rounds a fractional share UP — 10% of 31 is 4 bottles, not 3.1", () => {
    const copper = tierSpec(2)!;
    expect(bottlesForTier(copper, 31)).toBe(4);
    expect(bottlesForTier(copper, 30)).toBe(3);
  });

  it("never drops below a tier's floor, even for an empty catalog", () => {
    for (const spec of PASSPORT_TIER_SPECS) {
      for (const total of CATALOG_SIZES) {
        expect(bottlesForTier(spec, total)).toBeGreaterThanOrEqual(spec.minBottles);
      }
    }
  });

  it("is non-decreasing in catalog size and strictly increasing up the ladder", () => {
    for (const spec of PASSPORT_TIER_SPECS) {
      let prev = 0;
      for (const total of CATALOG_SIZES) {
        const need = bottlesForTier(spec, total);
        expect(need).toBeGreaterThanOrEqual(prev);
        prev = need;
      }
    }
    for (const total of CATALOG_SIZES) {
      const needs = PASSPORT_TIER_SPECS.map((s) => bottlesForTier(s, total));
      for (let i = 1; i < needs.length; i++) expect(needs[i]).toBeGreaterThan(needs[i - 1]);
    }
  });
});

describe("tierForCount", () => {
  it("is 0 for nothing met, including nonsense negative counts", () => {
    for (const total of CATALOG_SIZES) {
      expect(tierForCount(0, total)).toBe(0);
      expect(tierForCount(-3, total)).toBe(0);
    }
  });

  it("is exactly the highest tier whose threshold the count clears", () => {
    for (const total of CATALOG_SIZES) {
      for (let met = 1; met <= Math.max(total, 25) + 5; met++) {
        const expected = PASSPORT_TIER_SPECS.filter((s) => met >= bottlesForTier(s, total)).reduce(
          (hi, s) => Math.max(hi, s.tier),
          0,
        );
        expect(tierForCount(met, total)).toBe(expected);
      }
    }
  });

  it("flips at each threshold: one bottle short stays below, the threshold earns it", () => {
    const total = 100;
    for (const spec of PASSPORT_TIER_SPECS) {
      const need = bottlesForTier(spec, total);
      expect(tierForCount(need, total)).toBe(spec.tier);
      expect(tierForCount(need - 1, total)).toBe(spec.tier - 1);
    }
  });

  it("never goes backwards as more distinct bottles are met", () => {
    for (const total of CATALOG_SIZES) {
      let prev = 0;
      for (let met = 0; met <= 120; met++) {
        const tier = tierForCount(met, total);
        expect(tier).toBeGreaterThanOrEqual(prev);
        prev = tier;
      }
    }
  });

  it("tolerates a met count above the catalog total (the catalog shrank) and caps at the top tier", () => {
    expect(tierForCount(500, 24)).toBe(5);
    expect(tierForCount(30, 24)).toBe(5);
    // A shrinking catalog can only make tiers cheaper, never take one away.
    expect(tierForCount(12, 20)).toBeGreaterThanOrEqual(tierForCount(12, 24));
  });

  it("caps a tiny catalog at the tier its floor allows, however complete", () => {
    // Everything in a 2-bottle country is still only Oak: Copper's floor is 3.
    expect(tierForCount(2, 2)).toBe(1);
    // 19 of 19 clears Gold (floor 12) but not Amber (floor 20).
    expect(tierForCount(19, 19)).toBe(4);
    expect(tierForCount(20, 20)).toBe(5);
  });
});

import { describe, expect, it } from "vitest";
import {
  computePalateProfile,
  cosineSimilarity,
  inferPriceBand,
  palateHeat,
  palateWheelHeat,
  priceInBand,
  recencyDecay,
  tasteMatchPercent,
  topWedges,
  NEUTRAL_RATING,
  RECENCY_HALF_LIFE_DAYS,
  type PalateEntry,
} from "./palate";

const NOW = new Date("2026-07-19T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("recencyDecay", () => {
  it("is 1 at age 0 and 0.5 at one half-life", () => {
    expect(recencyDecay(NOW, NOW)).toBe(1);
    expect(recencyDecay(daysAgo(RECENCY_HALF_LIFE_DAYS), NOW)).toBeCloseTo(0.5, 6);
    expect(recencyDecay(daysAgo(2 * RECENCY_HALF_LIFE_DAYS), NOW)).toBeCloseTo(0.25, 6);
  });

  it("clamps future timestamps to 1 (no negative age)", () => {
    expect(recencyDecay(daysAgo(-10), NOW)).toBe(1);
  });
});

describe("computePalateProfile", () => {
  it("pushes wedges positive for liked bottles and negative for disliked", () => {
    const entries: PalateEntry[] = [
      { rating: 5, flavorTags: null, bottleProfile: { peaty: 10 }, createdAt: NOW },
      { rating: 1, flavorTags: null, bottleProfile: { sweet: 10 }, createdAt: NOW },
    ];
    const { vector, sampleSize } = computePalateProfile(entries, NOW);
    expect(sampleSize).toBe(2);
    // rating 5 → weight (5-3)=+2 on peaty; rating 1 → (1-3)=-2 on sweet.
    expect(vector.peaty).toBeCloseTo(2, 6);
    expect(vector.sweet).toBeCloseTo(-2, 6);
    expect(vector.fruity).toBe(0);
  });

  it("prefers rolled-up tasting-note tags over the bottle profile", () => {
    // Tag vanilla intensity 2 → rollUpToWedges → sweet ~5; bottleProfile ignored.
    const entries: PalateEntry[] = [
      { rating: 5, flavorTags: { vanilla: 2 }, bottleProfile: { peaty: 10 }, createdAt: NOW },
    ];
    const { vector } = computePalateProfile(entries, NOW);
    expect(vector.sweet).toBeGreaterThan(0);
    expect(vector.peaty).toBe(0);
  });

  it("decays older pours toward zero", () => {
    const recent = computePalateProfile(
      [{ rating: 5, flavorTags: null, bottleProfile: { woody: 10 }, createdAt: NOW }],
      NOW,
    );
    const old = computePalateProfile(
      [
        {
          rating: 5,
          flavorTags: null,
          bottleProfile: { woody: 10 },
          createdAt: daysAgo(RECENCY_HALF_LIFE_DAYS),
        },
      ],
      NOW,
    );
    expect(old.vector.woody).toBeCloseTo(recent.vector.woody / 2, 6);
  });

  it("treats unrated pours as a mild positive signal", () => {
    const { vector, sampleSize } = computePalateProfile(
      [{ rating: null, flavorTags: null, bottleProfile: { grain: 10 }, createdAt: NOW }],
      NOW,
    );
    expect(sampleSize).toBe(1);
    expect(vector.grain).toBeGreaterThan(0);
    expect(vector.grain).toBeLessThan(NEUTRAL_RATING);
  });

  it("ignores entries with no flavor signal", () => {
    const { vector, sampleSize } = computePalateProfile(
      [{ rating: 5, flavorTags: {}, bottleProfile: null, createdAt: NOW }],
      NOW,
    );
    expect(sampleSize).toBe(0);
    expect(Object.values(vector).every((v) => v === 0)).toBe(true);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for parallel vectors and 0 for orthogonal", () => {
    expect(cosineSimilarity({ peaty: 3 }, { peaty: 9 })).toBeCloseTo(1, 6);
    expect(cosineSimilarity({ peaty: 5 }, { sweet: 5 })).toBeCloseTo(0, 6);
  });

  it("is 0 when either vector is all-zero", () => {
    expect(cosineSimilarity({}, { sweet: 5 })).toBe(0);
  });
});

describe("tasteMatchPercent", () => {
  it("returns a rounded percentage for aligned profiles", () => {
    const palate = { peaty: 4, woody: 2 };
    const match = tasteMatchPercent(palate, { peaty: 8, woody: 4 }, 3);
    expect(match).toBe(100);
  });

  it("clamps opposite tastes to 0", () => {
    const palate = { peaty: 5, sweet: -5 };
    expect(tasteMatchPercent(palate, { sweet: 10 }, 3)).toBe(0);
  });

  it("is null with no palate signal or no bottle profile", () => {
    expect(tasteMatchPercent({ peaty: 5 }, { peaty: 5 }, 0)).toBeNull();
    expect(tasteMatchPercent({ peaty: 5 }, null, 3)).toBeNull();
    expect(tasteMatchPercent({ peaty: 5 }, {}, 3)).toBeNull();
  });
});

describe("computePalateProfile leaf detail", () => {
  it("carries the wedge weight's sign down to each tagged descriptor", () => {
    const entries: PalateEntry[] = [
      { rating: 5, flavorTags: { campfire: 3 }, bottleProfile: null, createdAt: NOW },
      { rating: 1, flavorTags: { vanilla: 3 }, bottleProfile: null, createdAt: NOW },
    ];
    const { leaves } = computePalateProfile(entries, NOW);
    expect(leaves.campfire).toBeGreaterThan(0);
    expect(leaves.vanilla).toBeLessThan(0);
  });

  it("scales a descriptor by its tagged intensity", () => {
    const entries: PalateEntry[] = [
      { rating: 5, flavorTags: { campfire: 3, brine: 1 }, bottleProfile: null, createdAt: NOW },
    ];
    const { leaves } = computePalateProfile(entries, NOW);
    expect(leaves.campfire).toBeCloseTo(leaves.brine * 3, 6);
  });

  it("decays with age like the wedge vector does", () => {
    const tags = { campfire: 3 };
    const recent = computePalateProfile(
      [{ rating: 5, flavorTags: tags, bottleProfile: null, createdAt: NOW }],
      NOW,
    );
    const old = computePalateProfile(
      [
        {
          rating: 5,
          flavorTags: tags,
          bottleProfile: null,
          createdAt: daysAgo(RECENCY_HALF_LIFE_DAYS),
        },
      ],
      NOW,
    );
    expect(old.leaves.campfire).toBeCloseTo(recent.leaves.campfire / 2, 6);
  });

  it("stays empty for pours with no tagged note, since a catalog profile has no leaves", () => {
    const entries: PalateEntry[] = [
      { rating: 5, flavorTags: null, bottleProfile: { peaty: 10 }, createdAt: NOW },
    ];
    const { vector, leaves } = computePalateProfile(entries, NOW);
    expect(vector.peaty).toBeGreaterThan(0);
    expect(leaves).toEqual({});
  });

  it("drops leaf ids outside the taxonomy", () => {
    const entries: PalateEntry[] = [
      { rating: 5, flavorTags: { campfire: 3, "not-a-leaf": 3 }, bottleProfile: null, createdAt: NOW },
    ];
    expect(Object.keys(computePalateProfile(entries, NOW).leaves)).toEqual(["campfire"]);
  });
});

describe("palateHeat", () => {
  it("clips negatives and normalizes the strongest entry to 1", () => {
    expect(palateHeat({ peaty: 4, woody: 2, sweet: -3 })).toEqual({ peaty: 1, woody: 0.5 });
  });

  it("omits zero and negative entries rather than reporting them as measured", () => {
    const heat = palateHeat({ peaty: 4, sweet: -3, woody: 0 });
    expect(heat.sweet).toBeUndefined();
    expect(heat.woody).toBeUndefined();
  });

  it("is empty when nothing is liked, so the wheel reads as cold", () => {
    expect(palateHeat({ sweet: -1 })).toEqual({});
    expect(palateHeat({})).toEqual({});
  });

  it("works at leaf granularity too", () => {
    expect(palateHeat({ campfire: 2, vanilla: 1 })).toEqual({ campfire: 1, vanilla: 0.5 });
  });
});

describe("palateWheelHeat", () => {
  const profile = (vector: Record<string, number>, leaves: Record<string, number>, sampleSize = 3) =>
    ({ vector, leaves, sampleSize });

  it("floors a family at its hottest descriptor, like the bar heat map does", () => {
    // Sweet dominates the wedge vector, so peaty normalizes low — but campfire
    // is the only leaf and normalizes to 1. Without reconciliation the wheel
    // would paint a blazing leaf inside a nearly cold family.
    const heat = palateWheelHeat(profile({ sweet: 10, peaty: 1 }, { campfire: 2 }));
    expect(heat.leaves).toEqual({ campfire: 1 });
    expect(heat.wedges.peaty).toBe(1);
    expect(heat.wedges.sweet).toBe(1);
  });

  it("keeps a family hotter than its descriptors unchanged", () => {
    const heat = palateWheelHeat(profile({ peaty: 10 }, { campfire: 10, brine: 1 }));
    expect(heat.wedges.peaty).toBe(1);
    expect(heat.leaves.brine).toBeCloseTo(0.1, 6);
  });

  it("surfaces a liked descriptor whose family cancelled to nothing", () => {
    // campfire liked, brine disliked, both Peaty: the wedge nets to zero.
    const heat = palateWheelHeat(profile({ peaty: 0 }, { campfire: 2, brine: -2 }));
    expect(heat.leaves).toEqual({ campfire: 1 });
    expect(heat.wedges.peaty).toBe(1);
  });

  it("carries sampleSize and top wedges through", () => {
    const heat = palateWheelHeat(profile({ peaty: 4, sweet: 2 }, {}, 7));
    expect(heat.sampleSize).toBe(7);
    expect(heat.topWedgeIds).toEqual(["peaty", "sweet"]);
  });

  it("is empty for a palate with no positive signal", () => {
    const heat = palateWheelHeat(profile({ sweet: -1 }, {}, 1));
    expect(heat.wedges).toEqual({});
    expect(heat.leaves).toEqual({});
  });
});

describe("topWedges", () => {
  it("returns the strongest positive wedges in order", () => {
    expect(topWedges({ peaty: 4, woody: 2, sweet: -1, fruity: 3 }, 2)).toEqual(["peaty", "fruity"]);
  });
});

describe("inferPriceBand / priceInBand", () => {
  it("returns null with no priced purchases", () => {
    expect(inferPriceBand([])).toBeNull();
    expect(inferPriceBand([null, undefined, 0])).toBeNull();
  });

  it("spans a widened interquartile range around what was paid", () => {
    const band = inferPriceBand([40, 50, 60, 70, 80])!;
    expect(band.median).toBeCloseTo(60, 6);
    expect(band.min).toBeLessThan(50);
    expect(band.max).toBeGreaterThan(70);
  });

  it("lets unknown prices pass and enforces the band otherwise", () => {
    const band = inferPriceBand([50, 60, 70])!;
    expect(priceInBand(null, band)).toBe(true);
    expect(priceInBand(band.median, band)).toBe(true);
    expect(priceInBand(band.max + 1000, band)).toBe(false);
    expect(priceInBand(9999, null)).toBe(true);
  });
});

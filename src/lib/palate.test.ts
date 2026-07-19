import { describe, expect, it } from "vitest";
import {
  computePalateProfile,
  cosineSimilarity,
  displayPalateWheel,
  inferPriceBand,
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

describe("displayPalateWheel", () => {
  it("clips negatives and normalizes the strongest wedge to 10", () => {
    const wheel = displayPalateWheel({ peaty: 4, sweet: -3, woody: 2 });
    expect(wheel.peaty).toBe(10);
    expect(wheel.woody).toBe(5);
    expect(wheel.sweet).toBe(0);
  });

  it("is all-zero when there is no positive signal", () => {
    const wheel = displayPalateWheel({ sweet: -1 });
    expect(Object.values(wheel).every((v) => v === 0)).toBe(true);
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

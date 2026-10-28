import { describe, expect, it } from "vitest";
import { discoverHighlight } from "@/lib/recommend";
import type { BadgeProgress } from "@/lib/passport-progress";

const progress = (over: Partial<BadgeProgress>): BadgeProgress => ({
  family: "region",
  value: "Islay",
  label: "Islay",
  heldTier: 0,
  targetTier: 1,
  targetName: "Oak",
  targetNumeral: "I",
  remaining: 1,
  ...over,
});
// Unsigned exposure (Bar flavor heat, 0–1): peaty untouched, woody/sweet well explored.
const explored = { peaty: 0, woody: 1, sweet: 0.7, fruity: 0.05 };

describe("discoverHighlight", () => {
  it("names somewhere new first", () => {
    expect(discoverHighlight({ progress: progress({}), explored, flavorProfile: null, matchPercent: 90 })).toEqual({ kind: "new-region", text: "New region for you · Islay" });
    expect(discoverHighlight({ progress: progress({ family: "country", label: "Japan" }), explored, flavorProfile: null, matchPercent: null })?.kind).toBe("new-country");
    expect(discoverHighlight({ progress: progress({ family: "style", label: "Rye" }), explored, flavorProfile: null, matchPercent: null })?.text).toBe("New style for you · Rye");
  });
  it("then a flavor family the bottle leans on that the wheel hasn't explored", () => {
    expect(
      discoverHighlight({ progress: progress({ heldTier: 2 }), explored, flavorProfile: { peaty: 8, woody: 5, fruity: 2 }, matchPercent: 80 }),
    ).toEqual({ kind: "flavor-gap", text: "Fills a gap on your wheel · Smoky" });
  });
  it("then a strong palate match, else nothing", () => {
    expect(discoverHighlight({ progress: null, explored, flavorProfile: { woody: 8, sweet: 6 }, matchPercent: 82 })).toEqual({ kind: "palate-match", text: "82% palate match" });
    expect(discoverHighlight({ progress: null, explored, flavorProfile: { woody: 8 }, matchPercent: 50 })).toBeNull();
    expect(discoverHighlight({ progress: null, explored: {}, flavorProfile: { peaty: 8 }, matchPercent: null })).toBeNull();
  });
  it("a family tasted a lot but rated both ways is not a gap", () => {
    // The signed palate would be ~0 for smoky here; exposure says it's well explored.
    expect(discoverHighlight({ progress: null, explored: { peaty: 0.9, woody: 1 }, flavorProfile: { peaty: 9 }, matchPercent: null })).toBeNull();
  });
  it("never speaks in quantities poured", () => {
    const out = discoverHighlight({ progress: progress({}), explored, flavorProfile: null, matchPercent: null });
    expect(out?.text).not.toMatch(/pour|ml|dram|streak|more/i);
  });
});

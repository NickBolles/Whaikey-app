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
const palate = { peaty: 0, woody: 0.8, sweet: 0.6, fruity: 0.02 };

describe("discoverHighlight", () => {
  it("names somewhere new first", () => {
    expect(discoverHighlight({ progress: progress({}), palate, flavorProfile: null, matchPercent: 90 })).toEqual({ kind: "new-region", text: "New region for you · Islay" });
    expect(discoverHighlight({ progress: progress({ family: "country", label: "Japan" }), palate, flavorProfile: null, matchPercent: null })?.kind).toBe("new-country");
    expect(discoverHighlight({ progress: progress({ family: "style", label: "Rye" }), palate, flavorProfile: null, matchPercent: null })?.text).toBe("New style for you · Rye");
  });
  it("then a flavor family the bottle leans on that the wheel hasn't explored", () => {
    expect(
      discoverHighlight({ progress: progress({ heldTier: 2 }), palate, flavorProfile: { peaty: 8, woody: 5, fruity: 2 }, matchPercent: 80 }),
    ).toEqual({ kind: "flavor-gap", text: "Fills a gap on your wheel · Smoky" });
  });
  it("then a strong palate match, else nothing", () => {
    expect(discoverHighlight({ progress: null, palate, flavorProfile: { woody: 8, sweet: 6 }, matchPercent: 82 })).toEqual({ kind: "palate-match", text: "82% palate match" });
    expect(discoverHighlight({ progress: null, palate, flavorProfile: { woody: 8 }, matchPercent: 50 })).toBeNull();
    expect(discoverHighlight({ progress: null, palate: {}, flavorProfile: { peaty: 8 }, matchPercent: null })).toBeNull();
  });
  it("never speaks in quantities poured", () => {
    const out = discoverHighlight({ progress: progress({}), palate, flavorProfile: null, matchPercent: null });
    expect(out?.text).not.toMatch(/pour|ml|dram|streak|more/i);
  });
});

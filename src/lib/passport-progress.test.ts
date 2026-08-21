import { describe, expect, it } from "vitest";
import type { Passport, PassportBadge } from "@/lib/passport";
import { badgeProgressCaption, badgeProgressFor } from "@/lib/passport-progress";
import type { PassportFamily } from "@/db/schema";

function badge(
  family: PassportFamily,
  value: string,
  metCount: number,
  catalogTotal: number,
  heldTier: number,
): PassportBadge {
  return {
    family,
    value,
    label: value,
    metCount,
    catalogTotal,
    currentTier: heldTier,
    heldTier,
    achievedAt: {},
  };
}

function passport(overrides: Partial<Passport> = {}): Passport {
  return { countries: [], regions: [], styles: [], ...overrides };
}

describe("badgeProgressFor", () => {
  it("opens a brand-new badge at Oak I for a stamp never met", () => {
    const progress = badgeProgressFor(passport(), {
      country: "Japan",
      region: null,
      category: "japanese",
    });
    expect(progress).toMatchObject({
      family: "country",
      value: "Japan",
      heldTier: 0,
      targetTier: 1,
      targetName: "Oak",
      remaining: 1,
    });
    expect(badgeProgressCaption(progress!)).toBe("opens the badge");
  });

  it("prefers the broadest unmet stamp — a new country over a new region or style", () => {
    const progress = badgeProgressFor(passport(), {
      country: "Japan",
      region: "Hokkaido",
      category: "japanese",
    });
    expect(progress?.family).toBe("country");
  });

  it("labels a style badge with its display name, not its id", () => {
    const progress = badgeProgressFor(passport(), {
      country: null,
      region: null,
      category: "scotch-single-malt",
    });
    expect(progress).toMatchObject({ family: "style", label: "Single Malt Scotch" });
  });

  it("counts down to the next tier of a badge already held", () => {
    // 24 Islay bottles in the catalog: Silver III needs ceil(.25 * 24) = 6.
    const progress = badgeProgressFor(
      passport({
        regions: [badge("region", "Islay", 5, 24, 2)],
        styles: [badge("style", "scotch-single-malt", 30, 30, 5)],
      }),
      { country: null, region: "Islay", category: "scotch-single-malt" },
    );
    expect(progress).toMatchObject({
      family: "region",
      heldTier: 2,
      targetTier: 3,
      targetName: "Silver",
      remaining: 1,
    });
    expect(badgeProgressCaption(progress!)).toBe("earns Silver III");
  });

  it("reads several bottles out as a countdown, not a completion", () => {
    const progress = badgeProgressFor(
      passport({
        regions: [badge("region", "Islay", 4, 24, 2)],
        styles: [badge("style", "scotch-single-malt", 30, 30, 5)],
      }),
      { country: null, region: "Islay", category: "scotch-single-malt" },
    );
    expect(progress?.remaining).toBe(2);
    expect(badgeProgressCaption(progress!)).toBe("2 more to Silver III");
  });

  it("stays quiet when the next tier is further off than a nudge can carry", () => {
    // Gold IV needs 12 of 24; at 6 met that is 6 bottles away.
    expect(
      badgeProgressFor(
        passport({
          regions: [badge("region", "Islay", 6, 24, 3)],
          styles: [badge("style", "scotch-single-malt", 30, 30, 5)],
        }),
        { country: null, region: "Islay", category: "scotch-single-malt" },
      ),
    ).toBeNull();
  });

  it("stays quiet once every tier of every stamp is held", () => {
    expect(
      badgeProgressFor(
        passport({
          countries: [badge("country", "Scotland", 40, 40, 5)],
          regions: [badge("region", "Islay", 24, 24, 5)],
          styles: [badge("style", "scotch-single-malt", 30, 30, 5)],
        }),
        { country: "Scotland", region: "Islay", category: "scotch-single-malt" },
      ),
    ).toBeNull();
  });

  it("picks the stamp closest to its next tier when none is brand new", () => {
    const progress = badgeProgressFor(
      passport({
        // Scotland: Copper II at 3 of 40 → 2 away.
        countries: [badge("country", "Scotland", 1, 40, 1)],
        // Islay: Copper II at 3 of 24 → 1 away.
        regions: [badge("region", "Islay", 2, 24, 1)],
      }),
      { country: "Scotland", region: "Islay", category: "scotch-single-malt" },
    );
    // The style stamp is unmet, so it wins outright on the "never been" rule.
    expect(progress?.family).toBe("style");

    const met = badgeProgressFor(
      passport({
        countries: [badge("country", "Scotland", 1, 40, 1)],
        regions: [badge("region", "Islay", 2, 24, 1)],
        styles: [badge("style", "scotch-single-malt", 2, 30, 1)],
      }),
      { country: "Scotland", region: "Islay", category: "scotch-single-malt" },
    );
    expect(met).toMatchObject({ family: "region", remaining: 1 });
  });

  it("ignores a stamp the bottle does not carry", () => {
    const progress = badgeProgressFor(
      passport({ styles: [badge("style", "bourbon", 2, 30, 1)] }),
      { country: null, region: null, category: "bourbon" },
    );
    expect(progress).toMatchObject({ family: "style", value: "bourbon", remaining: 1 });
  });
});

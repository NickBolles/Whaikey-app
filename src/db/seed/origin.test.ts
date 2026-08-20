import { describe, expect, it } from "vitest";
import { SEED_BOTTLES, SEED_DISTILLERIES, bottleOrigin } from "./data";
import { originLabel } from "@/lib/origin";

const distilleryCountry = new Map(SEED_DISTILLERIES.map((d) => [d.id, d.country]));

function originOf(bottle: (typeof SEED_BOTTLES)[number]) {
  return bottleOrigin(bottle, bottle.distilleryId ? distilleryCountry.get(bottle.distilleryId) : null);
}

describe("bottleOrigin", () => {
  it("inherits the country from the distillery", () => {
    expect(
      bottleOrigin({ distilleryId: "lagavulin", region: "Islay" }, "Scotland"),
    ).toEqual({ country: "Scotland", region: "Islay" });
  });

  it("prefers an explicitly declared country", () => {
    // Blends and sourced bottlings have no distillery to inherit from.
    expect(
      bottleOrigin({ distilleryId: null, country: "Canada", region: "Ontario" }, null),
    ).toEqual({ country: "Canada", region: "Ontario" });
  });

  it("drops a region that is really the country", () => {
    // The old habit: a blend stored "Scotland" in the region column, which made
    // it look like a peer of Islay to anything counting distinct regions.
    expect(
      bottleOrigin({ distilleryId: null, country: "Scotland", region: "Scotland" }, null),
    ).toEqual({ country: "Scotland", region: null });
  });

  it("leaves a bottle with no origin alone rather than inventing one", () => {
    expect(bottleOrigin({ distilleryId: null }, null)).toEqual({ country: null, region: null });
  });
});

describe("the seeded catalog", () => {
  it("knows the country of every bottle", () => {
    // The property the passport's country dimension depends on: unlike region,
    // this one is never absent, including for blends with no distillery.
    const missing = SEED_BOTTLES.filter((b) => originOf(b).country == null).map((b) => b.id);
    expect(missing).toEqual([]);
  });

  it("never stores a country in the region column", () => {
    const countries = new Set(SEED_DISTILLERIES.map((d) => d.country));
    const offenders = SEED_BOTTLES.filter((b) => {
      const region = originOf(b).region;
      return region != null && countries.has(region);
    }).map((b) => `${b.id}: ${b.region}`);
    expect(offenders).toEqual([]);
  });

  it("resolves the blends that used to masquerade as a region", () => {
    const blend = SEED_BOTTLES.find((b) => b.id === "johnnie-walker-black");
    expect(originOf(blend!)).toEqual({ country: "Scotland", region: null });
    // Still shows an origin on screen — the country, not a blank.
    expect(originLabel(originOf(blend!).region, originOf(blend!).country)).toBe("Scotland");
  });

  it("keeps the sub-national detail where the catalog has it", () => {
    const lagavulin = SEED_BOTTLES.find((b) => b.id === "lagavulin-16");
    expect(originOf(lagavulin!)).toEqual({ country: "Scotland", region: "Islay" });
    const jeffersons = SEED_BOTTLES.find((b) => b.id === "jeffersons-ocean");
    expect(originOf(jeffersons!)).toEqual({ country: "USA", region: "Kentucky" });
  });
});

describe("originLabel", () => {
  it("names the most specific origin available", () => {
    expect(originLabel("Islay", "Scotland")).toBe("Islay");
    expect(originLabel(null, "Scotland")).toBe("Scotland");
    expect(originLabel(null, null)).toBeNull();
  });
});

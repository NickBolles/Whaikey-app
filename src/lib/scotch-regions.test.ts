import { describe, expect, it } from "vitest";
import { SEED_BOTTLES, SEED_DISTILLERIES } from "@/db/seed/data";
import { getLesson } from "@/lib/education";
import {
  PROTECTED_SCOTCH_REGION_COUNT,
  SCOTCH_REGIONS,
  SCOTCH_BLEND_REGION,
  SCOTCH_REGION_COUNT,
  isScotchRegion,
  scotchRegion,
} from "./scotch-regions";

describe("the Scotch region contract", () => {
  it("counts six regions, five of them protected", () => {
    // Both numbers are true and they are not interchangeable: the regulations
    // protect five, the shelf (and our catalog) shows six. A counter that used
    // five would tell a Talisker drinker their region doesn't exist.
    expect(SCOTCH_REGION_COUNT).toBe(6);
    expect(PROTECTED_SCOTCH_REGION_COUNT).toBe(5);
    expect(SCOTCH_REGIONS.find((r) => !r.isProtected)?.id).toBe("Islands");
  });

  it("has unique ids and looks them up", () => {
    const ids = SCOTCH_REGIONS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(scotchRegion("Islay")?.label).toBe("Islay");
    expect(scotchRegion("Kentucky")).toBeNull();
    expect(scotchRegion(null)).toBeNull();
    expect(isScotchRegion("Islands")).toBe(true);
    expect(isScotchRegion("islands")).toBe(false); // ids are the stored strings, verbatim
  });
});

describe("the catalog agrees with the contract", () => {
  const scottishDistilleryIds = new Set(
    SEED_DISTILLERIES.filter((d) => d.country === "Scotland").map((d) => d.id),
  );

  it("uses only canonical region names on Scottish distilleries", () => {
    const offenders = SEED_DISTILLERIES.filter(
      (d) => d.country === "Scotland" && d.region != null && !isScotchRegion(d.region),
    ).map((d) => `${d.id}: ${d.region}`);
    expect(offenders).toEqual([]);
  });

  it("uses only canonical region names on Scottish bottles, or the blend marker", () => {
    // The drift guard that matters: a new bottle seeded as "Isle of Skye" or
    // "Highlands" would silently invent a seventh region and desync every
    // count derived from `bottles.region`. The one legitimate non-region value
    // is the blend marker.
    const offenders = SEED_BOTTLES.filter(
      (b) =>
        b.distilleryId != null &&
        scottishDistilleryIds.has(b.distilleryId) &&
        b.region != null &&
        b.region !== SCOTCH_BLEND_REGION &&
        !isScotchRegion(b.region),
    ).map((b) => `${b.id}: ${b.region}`);
    expect(offenders).toEqual([]);
  });

  it("only lets blends use the blend marker", () => {
    const misfiled = SEED_BOTTLES.filter(
      (b) => b.region === SCOTCH_BLEND_REGION && b.category !== "scotch-blended",
    ).map((b) => b.id);
    expect(misfiled).toEqual([]);
  });

  it("never counts a blend as a region", () => {
    // A blend is married from several regions and belongs to none. Counting
    // "Scotland" would gift a seventh region to anyone who bought a Johnnie
    // Walker — the bottle page may say Scotland, the passport may not.
    expect(isScotchRegion(SCOTCH_BLEND_REGION)).toBe(false);
    expect(SCOTCH_REGIONS.map((r) => r.id)).not.toContain(SCOTCH_BLEND_REGION);
  });

  it("actually stocks every region it claims to count", () => {
    // A denominator nothing can fill is a broken promise, not a stretch goal.
    const stocked = new Set(
      SEED_BOTTLES.filter((b) => b.distilleryId != null && scottishDistilleryIds.has(b.distilleryId))
        .map((b) => b.region)
        .filter((r): r is string => r != null),
    );
    for (const region of SCOTCH_REGIONS) {
      expect.soft(stocked.has(region.id), `no seeded bottle in ${region.id}`).toBe(true);
    }
  });
});

describe("the regions lesson", () => {
  const lesson = getLesson("scotch-regions");

  it("tours exactly the canonical set, in contract order", () => {
    const tour = lesson?.sections.find((s) => s.heading === "The tour");
    expect(tour?.bullets).toHaveLength(SCOTCH_REGION_COUNT);
    expect(tour?.bullets?.map((b) => b.split(" — ")[0])).toEqual(
      SCOTCH_REGIONS.map((r) => r.label),
    );
  });

  it("teaches both numbers rather than picking one", () => {
    const text = lesson?.sections.flatMap((s) => s.paragraphs ?? []).join(" ") ?? "";
    expect(text).toContain("5 protected regions");
    expect(text).toContain("Whaikey counts 6");
  });
});

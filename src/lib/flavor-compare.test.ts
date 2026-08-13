import { describe, expect, it } from "vitest";
import { compareFlavorNotes } from "@/lib/flavor-compare";

function allLeafIds(groups: { leafIds: string[] }[]): string[] {
  return groups.flatMap((g) => g.leafIds);
}

describe("compareFlavorNotes", () => {
  it("returns nothing for two empty inputs", () => {
    const result = compareFlavorNotes({}, {});
    expect(result).toEqual({ both: [], onlyMine: [], onlyTheirs: [] });
  });

  it("treats null/undefined the same as empty", () => {
    expect(compareFlavorNotes(null, undefined)).toEqual({ both: [], onlyMine: [], onlyTheirs: [] });
    expect(compareFlavorNotes(null, { vanilla: 2 })).toMatchObject({ both: [], onlyMine: [] });
  });

  it("splits fully disjoint notes into onlyMine and onlyTheirs, nothing shared", () => {
    const result = compareFlavorNotes({ vanilla: 2, oak: 1 }, { peat: 3, citrus: 2 });
    expect(result.both).toEqual([]);
    expect(allLeafIds(result.onlyMine).sort()).toEqual(["oak", "vanilla"]);
    expect(allLeafIds(result.onlyTheirs).sort()).toEqual(["citrus", "peat"]);
  });

  it("puts identical notes entirely in both, with nothing left over", () => {
    const tags = { vanilla: 3, oak: 2, peat: 1 };
    const result = compareFlavorNotes(tags, tags);
    expect(allLeafIds(result.both).sort()).toEqual(["oak", "peat", "vanilla"]);
    expect(result.onlyMine).toEqual([]);
    expect(result.onlyTheirs).toEqual([]);
  });

  it("ignores descriptor ids that are not on the flavor wheel", () => {
    const result = compareFlavorNotes(
      { vanilla: 2, "not-a-real-leaf": 5 },
      { vanilla: 2, "also-fake": 3 },
    );
    expect(allLeafIds(result.both)).toEqual(["vanilla"]);
    expect(result.onlyMine).toEqual([]);
    expect(result.onlyTheirs).toEqual([]);
  });

  it("orders leaves within a group by their intensity (theirs desc, then mine)", () => {
    // Both name vanilla and caramel (same "sweet" wedge): theirs ranks caramel
    // hotter than vanilla, so caramel should sort first despite mine ranking
    // vanilla hotter.
    const result = compareFlavorNotes({ vanilla: 3, caramel: 1 }, { vanilla: 1, caramel: 3 });
    expect(result.both).toHaveLength(1);
    expect(result.both[0].wedgeId).toBe("sweet");
    expect(result.both[0].leafIds).toEqual(["caramel", "vanilla"]);
  });

  it("groups leaves by wedge", () => {
    const result = compareFlavorNotes(
      { vanilla: 2, peat: 2 },
      { vanilla: 2, peat: 2 },
    );
    const wedgeIds = result.both.map((g) => g.wedgeId).sort();
    expect(wedgeIds).toEqual(["peaty", "sweet"]);
    for (const group of result.both) {
      expect(group.leafIds.length).toBeGreaterThan(0);
    }
  });
});

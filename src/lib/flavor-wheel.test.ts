import { describe, expect, it } from "vitest";
import {
  FLAVOR_WHEEL,
  WEDGE_IDS,
  floorWedgesAtLeaves,
  isValidLeaf,
  leafLabel,
  matchLeafIds,
  rollUpToWedges,
  wedgeForLeaf,
} from "./flavor-wheel";

describe("flavor wheel taxonomy", () => {
  it("has 8 wedges with unique ids", () => {
    expect(FLAVOR_WHEEL).toHaveLength(8);
    expect(new Set(WEDGE_IDS).size).toBe(8);
  });

  it("has unique leaf ids across all wedges", () => {
    const leaves = FLAVOR_WHEEL.flatMap((w) => w.leaves.map((l) => l.id));
    expect(new Set(leaves).size).toBe(leaves.length);
    expect(leaves.length).toBeGreaterThanOrEqual(45);
  });

  it("maps leaves to their wedge", () => {
    expect(wedgeForLeaf("vanilla")).toBe("sweet");
    expect(wedgeForLeaf("campfire")).toBe("peaty");
    expect(wedgeForLeaf("nonexistent")).toBeUndefined();
  });

  it("validates and labels leaves", () => {
    expect(isValidLeaf("green-apple")).toBe(true);
    expect(isValidLeaf("umami-bomb")).toBe(false);
    expect(leafLabel("green-apple")).toBe("Green apple");
  });

  it("rolls leaf tags up to wedge scores capped at 10", () => {
    const scores = rollUpToWedges({ vanilla: 3, caramel: 3, honey: 3, "green-apple": 1 });
    expect(scores.sweet).toBe(10);
    expect(scores.fruity).toBe(2.5);
    expect(scores.peaty).toBeUndefined();
  });

  it("ignores unknown leaves in rollup", () => {
    expect(rollUpToWedges({ bogus: 3 })).toEqual({});
  });
});

describe("floorWedgesAtLeaves", () => {
  it("raises a cold family to its hottest leaf", () => {
    // The contradiction this exists to prevent: a blazing leaf drawn inside a
    // barely-lit wedge, because the two rings normalize to different maxima.
    expect(floorWedgesAtLeaves({ peaty: 0.1, sweet: 1 }, { campfire: 1 })).toEqual({
      peaty: 1,
      sweet: 1,
    });
  });

  it("adds a wedge that had no heat of its own", () => {
    expect(floorWedgesAtLeaves({}, { campfire: 0.6 })).toEqual({ peaty: 0.6 });
  });

  it("leaves a family already hotter than its leaves alone", () => {
    expect(floorWedgesAtLeaves({ peaty: 1 }, { campfire: 0.3 })).toEqual({ peaty: 1 });
  });

  it("floors at the hottest leaf when a family has several", () => {
    expect(floorWedgesAtLeaves({ peaty: 0.1 }, { campfire: 0.4, brine: 0.9 })).toEqual({
      peaty: 0.9,
    });
  });

  it("ignores leaves outside the taxonomy and does not mutate its inputs", () => {
    const wedges = { peaty: 0.2 };
    const leaves = { "not-a-leaf": 1 };
    expect(floorWedgesAtLeaves(wedges, leaves)).toEqual({ peaty: 0.2 });
    expect(wedges).toEqual({ peaty: 0.2 });
  });
});

describe("matchLeafIds", () => {
  it("finds flavors named outright in a dictated note", () => {
    expect(matchLeafIds("Loads of vanilla and toasted oak, long warm finish")).toEqual(
      expect.arrayContaining(["vanilla", "oak", "char"]),
    );
  });

  it("stays literal — inflections the local pass misses are the model's job", () => {
    // "Char / toast" is not matched by "charred": widening the suffix list far
    // enough to catch it also starts matching unrelated words.
    expect(matchLeafIds("charred oak")).toEqual(["oak"]);
  });

  it("tolerates plural and adjectival forms", () => {
    expect(matchLeafIds("very oaky")).toContain("oak");
    expect(matchLeafIds("raisins on the nose")).toContain("raisin");
  });

  it("matches multi-word labels and either side of a slashed label", () => {
    expect(matchLeafIds("bright green apple")).toContain("green-apple");
    expect(matchLeafIds("dried fig sweetness")).toContain("raisin");
    expect(matchLeafIds("porridge and toast")).toContain("cereal");
  });

  it("matches on ids that read as synonyms of their label", () => {
    // The label is "Fresh cut grass"; a real note just says "grassy".
    expect(matchLeafIds("grassy and light")).toContain("grassy");
  });

  it("does not match a word that merely contains a flavor name", () => {
    expect(matchLeafIds("the smoker outside")).not.toContain("smoke");
    expect(matchLeafIds("peatland distillery tour")).not.toContain("peat");
  });

  it("returns nothing for empty or flavorless text", () => {
    expect(matchLeafIds("")).toEqual([]);
    expect(matchLeafIds("   ")).toEqual([]);
    expect(matchLeafIds("poured this after work")).toEqual([]);
  });

  it("only ever returns valid leaf ids", () => {
    for (const id of matchLeafIds("vanilla oak cherry brine campfire")) {
      expect(isValidLeaf(id)).toBe(true);
    }
  });
});

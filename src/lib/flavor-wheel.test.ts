import { describe, expect, it } from "vitest";
import {
  FLAVOR_WHEEL,
  WEDGE_IDS,
  isValidLeaf,
  leafLabel,
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

import { describe, expect, it } from "vitest";
import type { OutingBoardBottle } from "@/lib/outings";
import { arrivalToast, boardArrivals } from "./live";

const bottle = (over: Partial<OutingBoardBottle> = {}): OutingBoardBottle => ({
  key: "b:1",
  entryId: "e1",
  label: "Lagavulin 16",
  bottleId: "1",
  addedBy: "Sam",
  addedByMe: false,
  votes: [],
  notYet: [],
  average: null,
  groupTags: [],
  favourite: false,
  mine: null,
  ...over,
});
const vote = (who: string, rating: number, mine = false) => ({ who, mine, rating, note: null, tags: [] as string[] });

describe("boardArrivals", () => {
  it("announces a bottle someone else added", () => {
    expect(boardArrivals([], [bottle()])).toEqual([{ key: "b:1", kind: "bottle", message: "Sam added Lagavulin 16" }]);
  });
  it("stays quiet about the viewer's own additions and ratings", () => {
    expect(boardArrivals([], [bottle({ addedBy: "You", addedByMe: true })])).toEqual([]);
    expect(boardArrivals([bottle()], [bottle({ votes: [vote("You", 4, true)] })])).toEqual([]);
  });
  it("announces new and changed ratings by others", () => {
    const a = boardArrivals([bottle()], [bottle({ votes: [vote("Ana", 4)] })]);
    expect(a.map((x) => x.message)).toEqual(["Ana rated Lagavulin 16"]);
    const b = boardArrivals([bottle({ votes: [vote("Ana", 4)] })], [bottle({ votes: [vote("Ana", 5)] })]);
    expect(b.map((x) => x.message)).toEqual(["Ana updated their notes on Lagavulin 16"]);
  });
  it("never mentions pours or amounts", () => {
    const all = boardArrivals([], [bottle(), bottle({ key: "b:2", addedBy: null, votes: [vote("Ana", 3)] })]);
    for (const x of all) expect(x.message).not.toMatch(/pour|ml|oz|dram|drink/i);
  });
});

describe("arrivalToast", () => {
  it("summarises several arrivals in one line", () => {
    expect(arrivalToast([])).toBeNull();
    const a = boardArrivals([], [bottle(), bottle({ key: "b:2", label: "Ardbeg 10" })]);
    expect(arrivalToast(a)).toBe("Sam added Lagavulin 16, and 1 more");
  });
});

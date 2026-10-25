import { describe, expect, it } from "vitest";
import { bottleMeta, decideScan } from "./scan-decision";

const blantons = { id: "blantons", name: "Blanton's Original", distillery: "Buffalo Trace", region: "Kentucky", abv: 46.5 };
const gold = { id: "blantons-gold", name: "Blanton's Gold" };

describe("decideScan (design board S2/S3)", () => {
  it("an own-catalog match is exact: no confirm step", () => {
    expect(decideScan({ upc: "080244003302", matches: [blantons], candidates: [], externalName: null })).toEqual({
      kind: "exact",
      upc: "080244003302",
      bottle: blantons,
      alternatives: [],
    });
  });

  it("a barcode shared by several releases preselects the first and keeps the rest one chip away", () => {
    const d = decideScan({ upc: "1", matches: [blantons, gold], candidates: [], externalName: null });
    expect(d.kind).toBe("exact");
    if (d.kind === "exact") {
      expect(d.bottle.id).toBe("blantons");
      expect(d.alternatives.map((b) => b.id)).toEqual(["blantons-gold"]);
    }
  });

  it("unverified suggestions are never auto-picked", () => {
    const d = decideScan({ upc: "1", matches: [], candidates: [blantons, gold, blantons, gold], externalName: "BLANTONS" });
    expect(d).toMatchObject({ kind: "choose", externalName: "BLANTONS" });
    if (d.kind === "choose") expect(d.options).toHaveLength(3);
  });

  it("nothing known is a miss", () => {
    expect(decideScan({ upc: "1", matches: [], candidates: [], externalName: null })).toEqual({ kind: "miss", upc: "1" });
  });

  it("tolerates a malformed response", () => {
    expect(decideScan({ upc: "1" } as never)).toEqual({ kind: "miss", upc: "1" });
  });
});

describe("bottleMeta", () => {
  it("joins what is known, in a stable order", () => {
    expect(bottleMeta(blantons)).toBe("Buffalo Trace · Kentucky · 46.5%");
    expect(bottleMeta({ ageYears: 16, abv: 43 })).toBe("16y · 43%");
    expect(bottleMeta({})).toBe("");
  });
});

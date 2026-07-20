import { describe, expect, it } from "vitest";
import { heuristicMapping, normalizeImportRow, parseDelimited, type ColumnMapping } from "./import";

const emptyMapping = (over: Partial<ColumnMapping>): ColumnMapping => ({
  name: null,
  upc: null,
  relationship: null,
  status: null,
  fillLevel: null,
  quantity: null,
  purchasePrice: null,
  purchaseDate: null,
  store: null,
  location: null,
  notes: null,
  ...over,
});

describe("parseDelimited", () => {
  it("parses plain CSV with a header row", () => {
    const t = parseDelimited("Name,Price\nEagle Rare,39.99\nStagg,99.99\n");
    expect(t.headers).toEqual(["Name", "Price"]);
    expect(t.rows).toEqual([
      ["Eagle Rare", "39.99"],
      ["Stagg", "99.99"],
    ]);
  });

  it("handles quoted fields, embedded commas/newlines, and escaped quotes", () => {
    const t = parseDelimited('Name,Notes\n"Weller, Special Reserve","He said ""wow""\nGreat."');
    expect(t.rows).toEqual([["Weller, Special Reserve", 'He said "wow"\nGreat.']]);
  });

  it("sniffs tab and semicolon delimiters", () => {
    expect(parseDelimited("Name\tPrice\nA\t1").headers).toEqual(["Name", "Price"]);
    expect(parseDelimited("Name;Price\nA;1").headers).toEqual(["Name", "Price"]);
  });

  it("strips a BOM and CRLF line endings, skipping blank lines", () => {
    const t = parseDelimited("﻿Name,Price\r\nA,1\r\n\r\n");
    expect(t.headers).toEqual(["Name", "Price"]);
    expect(t.rows).toEqual([["A", "1"]]);
  });
});

describe("heuristicMapping", () => {
  it("maps common collector-spreadsheet headers", () => {
    const m = heuristicMapping(["Bottle", "UPC", "Price Paid", "Date Purchased", "Store", "Notes"]);
    expect(m.name).toBe(0);
    expect(m.upc).toBe(1);
    expect(m.purchasePrice).toBe(2);
    expect(m.purchaseDate).toBe(3);
    expect(m.store).toBe(4);
    expect(m.notes).toBe(5);
  });

  it("maps competitor-style export headers", () => {
    const m = heuristicMapping(["Whisky Name", "Barcode", "Status", "Fill Level", "Qty", "Location"]);
    expect(m.name).toBe(0);
    expect(m.upc).toBe(1);
    expect(m.status).toBe(2);
    expect(m.fillLevel).toBe(3);
    expect(m.quantity).toBe(4);
    expect(m.location).toBe(5);
  });

  it("never assigns the same column twice", () => {
    const m = heuristicMapping(["Price"]);
    const used = Object.values(m).filter((v) => v !== null);
    expect(new Set(used).size).toBe(used.length);
  });

  it("treats a single unlabeled-ish column as names", () => {
    expect(heuristicMapping(["My whiskies"]).name).toBe(0);
  });
});

describe("normalizeImportRow", () => {
  it("normalizes prices, dates, fill and quantity", () => {
    const mapping = emptyMapping({
      name: 0,
      purchasePrice: 1,
      purchaseDate: 2,
      fillLevel: 3,
      quantity: 4,
    });
    const row = normalizeImportRow(
      ["Eagle Rare", "$1,049.99", "2026-03-12", "62%", "2"],
      mapping,
    );
    expect(row.name).toBe("Eagle Rare");
    expect(row.purchasePrice).toBe(1049.99);
    expect(row.purchaseDate).toMatch(/^2026-03-12/);
    expect(row.fillLevel).toBe(62);
    expect(row.quantity).toBe(2);
  });

  it("maps relationship and status synonyms", () => {
    const mapping = emptyMapping({ name: 0, relationship: 1, status: 2 });
    expect(normalizeImportRow(["A", "Wanted", "Unopened"], mapping)).toMatchObject({
      relationship: "wishlist",
      status: "sealed",
    });
    expect(normalizeImportRow(["A", "Tasted", "Opened"], mapping)).toMatchObject({
      relationship: "tried",
      status: "open",
    });
  });

  it("falls back to the default relationship and nulls for junk values", () => {
    const mapping = emptyMapping({ name: 0, purchasePrice: 1, purchaseDate: 2 });
    const row = normalizeImportRow(["A", "n/a", "sometime"], mapping, "tried");
    expect(row.relationship).toBe("tried");
    expect(row.purchasePrice).toBeNull();
    expect(row.purchaseDate).toBeNull();
  });
});

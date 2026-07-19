import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { createTestBottle, setupTestDb, uid } from "@/test/helpers";
import {
  candidatesFromExternalName,
  confirmUpcMapping,
  isValidUpc,
  lookupExternalUpc,
  normalizeUpc,
  resolveUpc,
} from "./scan";

// A UPC-A with a valid GTIN check digit, used throughout.
const UPC = "080244002145";

describe("normalizeUpc", () => {
  it("strips spaces, hyphens, and other non-digits", () => {
    expect(normalizeUpc("0-80244-00214-5")).toBe(UPC);
    expect(normalizeUpc(" 080244 002145 ")).toBe(UPC);
  });

  it("strips GTIN-13/14 zero padding down to UPC-A", () => {
    expect(normalizeUpc("0080244002145")).toBe(UPC);
    expect(normalizeUpc("00080244002145")).toBe(UPC);
  });

  it("keeps genuine EAN-13 codes at 13 digits", () => {
    expect(normalizeUpc("5000267107011")).toBe("5000267107011");
  });

  it("rejects implausible lengths", () => {
    expect(normalizeUpc("1234")).toBeNull();
    expect(normalizeUpc("12345678901")).toBeNull(); // 11 digits
    expect(normalizeUpc("")).toBeNull();
    expect(normalizeUpc("no digits here")).toBeNull();
  });
});

describe("isValidUpc", () => {
  it("accepts codes with a valid GS1 check digit", () => {
    expect(isValidUpc(UPC)).toBe(true);
    expect(isValidUpc("5000267107011")).toBe(true); // EAN-13
  });

  it("rejects a wrong check digit", () => {
    expect(isValidUpc("080244002144")).toBe(false);
    expect(isValidUpc("5000267107012")).toBe(false);
  });

  it("rejects non-digit or wrong-length input", () => {
    expect(isValidUpc("abc")).toBe(false);
    expect(isValidUpc("12345678901")).toBe(false);
  });
});

describe("resolveUpc / confirmUpcMapping", () => {
  let db: DB;

  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("returns no matches for an unknown code", async () => {
    expect(await resolveUpc(db, UPC)).toEqual([]);
  });

  it("confirming creates a mapping that then resolves", async () => {
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10 Year" });
    const mapping = await confirmUpcMapping(db, UPC, bottle.id);
    expect(mapping.source).toBe("user");
    expect(mapping.confirmedCount).toBe(1);

    const matches = await resolveUpc(db, UPC);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(bottle.id);
    expect(matches[0].name).toBe("Eagle Rare 10 Year");
    expect(matches[0].confirmedCount).toBe(1);
  });

  it("re-confirming increments the count instead of duplicating", async () => {
    const bottle = await createTestBottle(db);
    await confirmUpcMapping(db, UPC, bottle.id);
    const second = await confirmUpcMapping(db, UPC, bottle.id);
    expect(second.confirmedCount).toBe(2);
    expect(await resolveUpc(db, UPC)).toHaveLength(1);
  });

  it("ranks shared barcodes by community confirmations", async () => {
    // Producers reuse UPCs across batches — the most-confirmed bottle wins.
    const older = await createTestBottle(db, { id: uid("older"), name: "Batch 2015" });
    const newer = await createTestBottle(db, { id: uid("newer"), name: "Batch 2023" });
    await confirmUpcMapping(db, UPC, older.id);
    await confirmUpcMapping(db, UPC, newer.id);
    await confirmUpcMapping(db, UPC, newer.id);

    const matches = await resolveUpc(db, UPC);
    expect(matches.map((m) => m.id)).toEqual([newer.id, older.id]);
  });
});

describe("lookupExternalUpc", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the UPCitemdb title when available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ items: [{ title: "Buffalo Trace Bourbon 750ml" }] }),
      ),
    );
    const product = await lookupExternalUpc(UPC);
    expect(product).toEqual({ name: "Buffalo Trace Bourbon 750ml", provider: "upcitemdb" });
  });

  it("falls back to Open Food Facts when UPCitemdb misses", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("upcitemdb")) return Response.json({ items: [] });
      return Response.json({ product: { product_name: "Lagavulin 16", brands: "Lagavulin" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const product = await lookupExternalUpc("5000267107011");
    expect(product).toEqual({ name: "Lagavulin Lagavulin 16", provider: "openfoodfacts" });
  });

  it("returns null when every provider errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    expect(await lookupExternalUpc(UPC)).toBeNull();
  });

  it("returns null on non-OK responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    expect(await lookupExternalUpc(UPC)).toBeNull();
  });
});

describe("candidatesFromExternalName", () => {
  let db: DB;

  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("matches a noisy retail product title to the catalog", async () => {
    const bottle = await createTestBottle(db, { name: "Buffalo Trace" });
    const results = await candidatesFromExternalName(
      db,
      "Buffalo Trace Kentucky Straight Bourbon Whiskey 750ml",
    );
    expect(results.map((r) => r.id)).toContain(bottle.id);
  });

  it("drops trailing words until something matches", async () => {
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10 Year" });
    const results = await candidatesFromExternalName(db, "Eagle Rare Nonexistent Variant Edition");
    expect(results.map((r) => r.id)).toContain(bottle.id);
  });

  it("returns empty for a title matching nothing", async () => {
    await createTestBottle(db);
    expect(await candidatesFromExternalName(db, "Totally Unknown Vodka")).toEqual([]);
  });
});

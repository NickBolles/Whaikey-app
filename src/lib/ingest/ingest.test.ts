import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { bottleAliases, bottles, bottleUpcs, pours, userBottles } from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { ingestCandidates, pruneImportedBottles } from "./index";
import type { CatalogCandidate } from "./types";

const candidate = (over: Partial<CatalogCandidate>): CatalogCandidate => ({
  name: "Imported Test Whiskey",
  category: "bourbon",
  source: "iowa",
  ...over,
});

describe("ingestCandidates", () => {
  let db: DB;

  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("inserts new bottles with status imported and attaches UPCs", async () => {
    const report = await ingestCandidates(db, "iowa", [
      candidate({ name: "Brand New Bourbon", abv: 45, avgPrice: 30, upcs: ["080244002145"] }),
    ]);
    expect(report).toMatchObject({ inserted: 1, matchedExisting: 0, upcsAdded: 1, dryRun: false });

    const [bottle] = await db.select().from(bottles).where(eq(bottles.id, "brand-new-bourbon"));
    expect(bottle).toMatchObject({
      name: "Brand New Bourbon",
      category: "bourbon",
      status: "imported",
      abv: 45,
      avgPrice: 30,
      flavorProfile: null,
      msrp: null,
    });
    const upcRows = await db.select().from(bottleUpcs).where(eq(bottleUpcs.upc, "080244002145"));
    expect(upcRows).toHaveLength(1);
    expect(upcRows[0]).toMatchObject({
      bottleId: "brand-new-bourbon",
      source: "iowa",
      confirmedCount: 0,
    });
  });

  it("tags UPC provenance with the source when it is a UpcSource, else seed", async () => {
    await ingestCandidates(db, "bc", [
      candidate({ name: "BC Import Rye", source: "bc", category: "rye", upcs: ["080244002145"] }),
    ]);
    await ingestCandidates(db, "whiskyedition", [
      candidate({ name: "Edition Malt", source: "whiskyedition", upcs: ["083664004607"] }),
    ]);
    const [bcUpc] = await db.select().from(bottleUpcs).where(eq(bottleUpcs.upc, "080244002145"));
    expect(bcUpc).toMatchObject({ bottleId: "bc-import-rye", source: "bc" });
    const [editionUpc] = await db.select().from(bottleUpcs).where(eq(bottleUpcs.upc, "083664004607"));
    expect(editionUpc).toMatchObject({ bottleId: "edition-malt", source: "seed" });
  });

  it("never duplicates a curated bottle: matches by name and by alias", async () => {
    const curated = await createTestBottle(db, {
      id: "eagle-rare-10",
      name: "Eagle Rare 10 Year",
      msrp: 40,
    });
    await db
      .insert(bottleAliases)
      .values({ id: uid("alias"), bottleId: curated.id, alias: "ER10" });

    const report = await ingestCandidates(db, "iowa", [
      candidate({ name: "Eagle Rare 10 Year", avgPrice: 99, upcs: ["080244002145"] }),
      candidate({ name: "ER10" }),
    ]);
    expect(report).toMatchObject({ inserted: 0, matchedExisting: 2, upcsAdded: 1 });

    // Curated fields untouched; the barcode attached to the curated bottle.
    const [after] = await db.select().from(bottles).where(eq(bottles.id, curated.id));
    expect(after.msrp).toBe(40);
    expect(after.status).toBe("verified");
    const upcRows = await db.select().from(bottleUpcs).where(eq(bottleUpcs.upc, "080244002145"));
    expect(upcRows[0].bottleId).toBe(curated.id);
    const all = await db.select().from(bottles);
    expect(all).toHaveLength(1);
  });

  it("is idempotent across re-runs", async () => {
    const cands = [
      candidate({ name: "Repeat Bourbon", upcs: ["080244002145"] }),
      candidate({ name: "Another Rye", category: "rye" }),
    ];
    const first = await ingestCandidates(db, "iowa", cands);
    expect(first).toMatchObject({ inserted: 2, upcsAdded: 1 });
    const second = await ingestCandidates(db, "iowa", cands);
    expect(second).toMatchObject({ inserted: 0, matchedExisting: 2, upcsAdded: 0 });
    expect(await db.select().from(bottles)).toHaveLength(2);
    expect(await db.select().from(bottleUpcs)).toHaveLength(1);
  });

  it("dedupes candidates that collide on slug within one run", async () => {
    const report = await ingestCandidates(db, "iowa", [
      candidate({ name: "Twin Peak Bourbon" }),
      candidate({ name: "Twin Peak  Bourbon" }),
    ]);
    expect(report.inserted + report.matchedExisting).toBe(2);
    expect(report.inserted).toBe(1);
    expect(await db.select().from(bottles)).toHaveLength(1);
  });

  it("links cross-source name variants to the same bottle and records an alias", async () => {
    await createTestBottle(db, { id: "glenlivet-12-year", name: "Glenlivet 12 Year" });

    const report = await ingestCandidates(db, "iowa", [
      candidate({ name: "The Glenlivet 12 YO Single Malt", category: "scotch-single-malt", abv: 40 }),
    ]);
    expect(report).toMatchObject({ inserted: 0, matchedExisting: 1, aliasesAdded: 1 });
    expect(await db.select().from(bottles)).toHaveLength(1);

    const aliases = await db.select().from(bottleAliases);
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({
      bottleId: "glenlivet-12-year",
      alias: "The Glenlivet 12 YO Single Malt",
    });

    // Re-run: the recorded alias now takes the exact-slug path; nothing duplicates.
    const rerun = await ingestCandidates(db, "iowa", [
      candidate({ name: "The Glenlivet 12 YO Single Malt", category: "scotch-single-malt" }),
    ]);
    expect(rerun).toMatchObject({ inserted: 0, matchedExisting: 1, aliasesAdded: 0 });
    expect(await db.select().from(bottleAliases)).toHaveLength(1);
  });

  it("collapses variants across sources within one run via the match key", async () => {
    const report = await ingestCandidates(db, "iowa", [
      candidate({ name: "Elijah Craig Small Batch", abv: 47 }),
      candidate({ name: "Elijah Craig Small Batch Kentucky Straight Bourbon Whiskey", avgPrice: 30 }),
    ]);
    expect(report).toMatchObject({ inserted: 1, matchedExisting: 1, aliasesAdded: 1 });
    const all = await db.select().from(bottles);
    expect(all).toHaveLength(1);
    expect(all[0].avgPrice).toBe(30); // filled onto the first-inserted row
  });

  it("never fuzzy-matches an ambiguous key shared by two existing bottles", async () => {
    await createTestBottle(db, { id: "a-bottle", name: "Twin Cask Whisky" });
    await createTestBottle(db, { id: "b-bottle", name: "Twin Cask Whiskey" }); // same key, different bottle

    const report = await ingestCandidates(db, "iowa", [candidate({ name: "Twin Cask Scotch" })]);
    expect(report).toMatchObject({ inserted: 1, matchedExisting: 0 });
    expect(await db.select().from(bottles)).toHaveLength(3);
  });

  it("fills null attributes on matched bottles and reports conflicts without overwriting", async () => {
    await createTestBottle(db, {
      id: "gap-bourbon",
      name: "Gap Bourbon",
      abv: 45,
      ageYears: null,
      region: null,
      avgPrice: null,
    });

    const report = await ingestCandidates(db, "iowa", [
      candidate({ name: "Gap Bourbon", abv: 50, ageYears: 9, region: "Kentucky", avgPrice: 35 }),
    ]);
    expect(report.matchedExisting).toBe(1);
    // ageYears, region, avgPrice were null → filled; abv disagreed by > 0.5 → conflict, kept.
    expect(report.fieldsFilled).toBe(3);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]).toMatch(/abv 50 \(iowa\) vs 45 \(stored\)/);

    const [after] = await db.select().from(bottles).where(eq(bottles.id, "gap-bourbon"));
    expect(after).toMatchObject({ abv: 45, ageYears: 9, region: "Kentucky", avgPrice: 35 });
  });

  it("tolerates small abv differences without logging a conflict", async () => {
    await createTestBottle(db, { id: "close-bourbon", name: "Close Bourbon", abv: 45 });
    const report = await ingestCandidates(db, "iowa", [
      candidate({ name: "Close Bourbon", abv: 45.4 }),
    ]);
    expect(report.conflicts).toHaveLength(0);
    const [after] = await db.select().from(bottles).where(eq(bottles.id, "close-bourbon"));
    expect(after.abv).toBe(45);
  });

  it("dry run reports without writing", async () => {
    const report = await ingestCandidates(
      db,
      "iowa",
      [candidate({ name: "Ghost Bourbon", upcs: ["080244002145"] })],
      { dryRun: true },
    );
    expect(report).toMatchObject({ inserted: 1, upcsAdded: 1, dryRun: true });
    expect(await db.select().from(bottles)).toHaveLength(0);
    expect(await db.select().from(bottleUpcs)).toHaveLength(0);
  });

  it("dry run previews aliases and fills without writing them", async () => {
    await createTestBottle(db, { id: "glenlivet-12-year", name: "Glenlivet 12 Year", abv: null });
    const report = await ingestCandidates(
      db,
      "iowa",
      [candidate({ name: "The Glenlivet 12 YO Single Malt", abv: 40 })],
      { dryRun: true },
    );
    expect(report).toMatchObject({ matchedExisting: 1, aliasesAdded: 1, fieldsFilled: 1 });
    expect(await db.select().from(bottleAliases)).toHaveLength(0);
    const [after] = await db.select().from(bottles).where(eq(bottles.id, "glenlivet-12-year"));
    expect(after.abv).toBeNull();
  });
});

describe("pruneImportedBottles", () => {
  let db: DB;

  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("removes untouched imported bottles but keeps user-referenced and curated ones", async () => {
    await ingestCandidates(db, "iowa", [
      candidate({ name: "Untouched Import" }),
      candidate({ name: "Owned Import" }),
      candidate({ name: "Poured Import" }),
    ]);
    await createTestBottle(db, { id: "curated-one", name: "Curated One" });

    const user = await createTestUser(db);
    await db.insert(userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: "owned-import",
      relationship: "own",
    });
    await db.insert(pours).values({
      id: uid("pour"),
      userId: user.id,
      bottleId: "poured-import",
      rating: 4,
    });

    const removed = await pruneImportedBottles(db);
    expect(removed).toBe(1);
    const remaining = (await db.select({ id: bottles.id }).from(bottles)).map((b) => b.id).sort();
    expect(remaining).toEqual(["curated-one", "owned-import", "poured-import"]);
  });
});

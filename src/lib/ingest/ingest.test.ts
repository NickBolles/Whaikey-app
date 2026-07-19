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

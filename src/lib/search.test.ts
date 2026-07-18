import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { setupTestDb, createTestBottle, uid } from "@/test/helpers";
import { searchBottles } from "@/lib/search";

let db: DB;

async function seedCatalog() {
  const [buffaloTrace] = await db
    .insert(schema.distilleries)
    .values({ id: uid("dist"), name: "Buffalo Trace", country: "USA", region: "Kentucky" })
    .returning();
  const [heavenHill] = await db
    .insert(schema.distilleries)
    .values({ id: uid("dist"), name: "Heaven Hill", country: "USA", region: "Kentucky" })
    .returning();
  const [lagavulin] = await db
    .insert(schema.distilleries)
    .values({ id: uid("dist"), name: "Lagavulin", country: "Scotland", region: "Islay" })
    .returning();

  const eagleRare = await createTestBottle(db, {
    name: "Eagle Rare",
    category: "bourbon",
    distilleryId: buffaloTrace.id,
  });
  const eagleRare10 = await createTestBottle(db, {
    name: "Eagle Rare 10 Year",
    category: "bourbon",
    distilleryId: buffaloTrace.id,
  });
  const eagleRare17 = await createTestBottle(db, {
    name: "Eagle Rare 17 Year",
    category: "bourbon",
    distilleryId: buffaloTrace.id,
  });
  const doubleEagle = await createTestBottle(db, {
    name: "Double Eagle Very Rare",
    category: "bourbon",
    distilleryId: buffaloTrace.id,
  });
  const ecbp = await createTestBottle(db, {
    name: "Elijah Craig Barrel Proof",
    category: "bourbon",
    distilleryId: heavenHill.id,
  });
  await db.insert(schema.bottleAliases).values([
    { id: uid("alias"), bottleId: ecbp.id, alias: "ECBP" },
    { id: uid("alias"), bottleId: ecbp.id, alias: "Elijah BP" },
  ]);
  const lag16 = await createTestBottle(db, {
    name: "Lagavulin 16",
    category: "scotch-single-malt",
    distilleryId: lagavulin.id,
    region: "Islay",
  });

  return { eagleRare, eagleRare10, eagleRare17, doubleEagle, ecbp, lag16 };
}

describe("searchBottles", () => {
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("matches every token across name/distillery ('eagle 10' finds Eagle Rare 10)", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "eagle 10");
    expect(results.map((r) => r.name)).toEqual(["Eagle Rare 10 Year"]);
  });

  it("is case-insensitive and joins distillery name", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "LAGAVULIN");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: "Lagavulin 16",
      category: "scotch-single-malt",
      distillery: "Lagavulin",
    });
  });

  it("matches on distillery name alone", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "buffalo trace");
    const names = results.map((r) => r.name);
    expect(names).toContain("Eagle Rare 10 Year");
    expect(names).toContain("Eagle Rare 17 Year");
  });

  it("finds bottles via aliases ('ecbp' -> Elijah Craig Barrel Proof)", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "ecbp");
    expect(results.map((r) => r.name)).toEqual(["Elijah Craig Barrel Proof"]);
  });

  it("ranks exact name > startsWith > contains > alias/token-only matches", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "eagle rare");
    const names = results.map((r) => r.name);
    // Exact match first.
    expect(names[0]).toBe("Eagle Rare");
    // startsWith next (alphabetical among themselves).
    expect(names.slice(1, 3)).toEqual(["Eagle Rare 10 Year", "Eagle Rare 17 Year"]);
    // Token-spread match ("Double Eagle Very Rare" contains both tokens but
    // not the phrase) comes last.
    expect(names[3]).toBe("Double Eagle Very Rare");
  });

  it("filters by category", async () => {
    await seedCatalog();
    const scotch = await searchBottles(db, "lagavulin", { category: "scotch-single-malt" });
    expect(scotch.map((r) => r.name)).toEqual(["Lagavulin 16"]);

    const bourbon = await searchBottles(db, "lagavulin", { category: "bourbon" });
    expect(bourbon).toEqual([]);
  });

  it("falls back to 4-char token prefixes when there are zero results", async () => {
    await seedCatalog();
    // "lagavulinn" (trailing typo) has no substring match; prefix "laga" does.
    const results = await searchBottles(db, "lagavulinn");
    expect(results.map((r) => r.name)).toEqual(["Lagavulin 16"]);
  });

  it("still returns nothing when even the prefix has no match", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "zzzz9999");
    expect(results).toEqual([]);
  });

  it("returns popular bottles ordered by name for an empty query", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "   ");
    const names = results.map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThanOrEqual(20);
  });

  it("applies the category filter to empty-query browsing too", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "", { category: "scotch-single-malt" });
    expect(results.map((r) => r.name)).toEqual(["Lagavulin 16"]);
  });

  it("respects the limit option", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "eagle", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("treats LIKE wildcards in the query literally", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "%");
    expect(results).toEqual([]);
  });
});

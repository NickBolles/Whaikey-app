import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { setupTestDb, createTestBottle, createTestUser, uid } from "@/test/helpers";
import { submitBottle } from "@/lib/catalog";
import {
  FUZZY_THRESHOLD,
  normalizeSearchText,
  searchBottles,
  searchTokens,
  tokenVariants,
} from "@/lib/search";

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

  it("tolerates a trailing-character typo ('lagavulinn')", async () => {
    await seedCatalog();
    const results = await searchBottles(db, "lagavulinn");
    expect(results.map((r) => r.name)).toEqual(["Lagavulin 16"]);
  });

  it("returns nothing for a query that resembles nothing", async () => {
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

describe("query normalization", () => {
  it("drops apostrophes, periods and hyphens the way catalogSearchKey does", () => {
    expect(normalizeSearchText("  Maker's  Mark ")).toBe("makers mark");
    expect(normalizeSearchText("Tullamore D.E.W.")).toBe("tullamore dew");
    expect(normalizeSearchText("Old Grand-Dad")).toBe("old granddad");
    expect(normalizeSearchText("Writers’ Tears")).toBe("writers tears");
  });

  it("folds age statements onto the number and keeps everything else", () => {
    expect(searchTokens("Lagavulin 16yr")).toEqual(["lagavulin", "16"]);
    expect(searchTokens("macallan 12 year old")).toEqual(["macallan", "12"]);
    expect(searchTokens("glenlivet 18 yo")).toEqual(["glenlivet", "18"]);
    // "old" is only an age word after a number: Old Forester keeps it.
    expect(searchTokens("old forester 1920")).toEqual(["old", "forester", "1920"]);
    expect(searchTokens("year")).toEqual(["year"]);
  });

  it("tries the sound-spellings trigrams cannot see, and a bounded number of them", () => {
    expect(tokenVariants("lafroig")).toContain("laphroig");
    expect(tokenVariants("johnny")).toContain("johnnie");
    expect(tokenVariants("yamazakki")).toContain("yamazaki");
    expect(tokenVariants("hibicki")).toContain("hibiki");
    for (const t of ["lafroig", "johnny", "ckckckyyff", "glenfiddich"]) {
      expect(tokenVariants(t)[0]).toBe(t);
      expect(tokenVariants(t).length).toBeLessThanOrEqual(5);
    }
  });
});

describe("searchBottles typo tolerance (WP-22)", () => {
  let fixtures: Awaited<ReturnType<typeof seedTypoCatalog>>;

  async function seedTypoCatalog() {
    const [laphroaig] = await db
      .insert(schema.distilleries)
      .values({ id: uid("dist"), name: "Laphroaig", country: "Scotland", region: "Islay" })
      .returning();
    const laphroaig10 = await createTestBottle(db, {
      name: "Laphroaig 10",
      category: "scotch-single-malt",
      distilleryId: laphroaig.id,
    });
    const laphroaigQc = await createTestBottle(db, {
      name: "Laphroaig Quarter Cask",
      category: "scotch-single-malt",
      distilleryId: laphroaig.id,
    });
    const makers = await createTestBottle(db, { name: "Maker's Mark 46", category: "bourbon" });
    const lagavulin = await createTestBottle(db, { name: "Lagavulin 16", category: "scotch-single-malt" });
    // A bottle whose name merely resembles "lagavulin" — the fuzzy pass will
    // find it, and it must never outrank the one spelled the way you typed.
    const lookalike = await createTestBottle(db, { name: "Lagavullin Reserve", category: "world" });
    const literal = await createTestBottle(db, { name: "Proof 100% Rye", category: "rye" });
    const notLiteral = await createTestBottle(db, { name: "Proof 1000 Rye", category: "rye" });
    return { laphroaig10, laphroaigQc, makers, lagavulin, lookalike, literal, notLiteral };
  }

  beforeEach(async () => {
    db = await setupTestDb();
    fixtures = await seedTypoCatalog();
  });

  it("resolves a respelled sound: 'lafroig' finds Laphroaig (FEATURES.md §2.1)", async () => {
    const results = await searchBottles(db, "lafroig");
    expect(results.map((r) => r.id).sort()).toEqual(
      [fixtures.laphroaig10.id, fixtures.laphroaigQc.id].sort(),
    );
  });

  it("combines a fuzzy token with an exact one ('laphroig 10')", async () => {
    const results = await searchBottles(db, "laphroig 10");
    expect(results.map((r) => r.id)).toEqual([fixtures.laphroaig10.id]);
  });

  it("requires short and numeric tokens to match exactly — '61' is not a typo we can know", async () => {
    expect(await searchBottles(db, "lagavulin 61")).toEqual([]);
  });

  it("matches across apostrophes without the user typing them", async () => {
    const results = await searchBottles(db, "makers mark 46");
    expect(results[0]?.id).toBe(fixtures.makers.id);
  });

  it("ranks every exact hit above every fuzzy one", async () => {
    const results = await searchBottles(db, "lagavulin");
    const ids = results.map((r) => r.id);
    expect(ids[0]).toBe(fixtures.lagavulin.id);
    // The lookalike is there — that is the typo pass working — but below.
    expect(ids).toContain(fixtures.lookalike.id);
    expect(ids.indexOf(fixtures.lookalike.id)).toBeGreaterThan(ids.indexOf(fixtures.lagavulin.id));
  });

  it("puts the closer resemblance first among fuzzy hits", async () => {
    // Neither is an exact hit for "lagavullen"; "Lagavullin" is one letter off,
    // "Lagavulin" two.
    const ids = (await searchBottles(db, "lagavullen")).map((r) => r.id);
    expect(ids.slice(0, 2)).toEqual([fixtures.lookalike.id, fixtures.lagavulin.id]);
  });

  it("does not run the typo pass when the exact pass already fills the top five", async () => {
    for (let i = 0; i < 5; i++) await createTestBottle(db, { name: `Lagavulin Cask ${i}` });
    const results = await searchBottles(db, "lagavulin");
    expect(results.map((r) => r.id)).not.toContain(fixtures.lookalike.id);
  });

  it("keeps LIKE wildcards literal on both passes", async () => {
    // A literal "%" matches the one name that contains one — not the catalog.
    expect((await searchBottles(db, "%")).map((r) => r.id)).toEqual([fixtures.literal.id]);
    expect(await searchBottles(db, "%%%")).toEqual([]);
    expect(await searchBottles(db, "___")).toEqual([]);
    // "100%" must mean the characters, not "100 followed by anything".
    const ids = (await searchBottles(db, "100%")).map((r) => r.id);
    expect(ids).toEqual([fixtures.literal.id]);
    expect(ids).not.toContain(fixtures.notLiteral.id);
  });

  it("applies the category filter to fuzzy hits too", async () => {
    expect(await searchBottles(db, "lafroig", { category: "bourbon" })).toEqual([]);
  });

  it("uses a threshold that separates a dropped letter from an unrelated word", () => {
    // Guard against someone raising it past the point "arbeg" (4/9 = 0.44
    // against "ardbeg") stops matching; see the constant's comment.
    expect(FUZZY_THRESHOLD).toBeLessThanOrEqual(0.44);
    expect(FUZZY_THRESHOLD).toBeGreaterThanOrEqual(0.35);
  });
});

describe("searchBottles visibility on the fuzzy path (PLAN-A1)", () => {
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("never shows another user's pending submission, exactly or approximately spelled", async () => {
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    const { bottle } = await submitBottle(db, alice.id, {
      name: "Glenwhinnie Private Cask",
      category: "scotch-single-malt",
    });

    for (const query of ["glenwhinnie", "glenwhinny", "glenwinnie private", "glenwhinie cask"]) {
      expect((await searchBottles(db, query, { viewerId: bob.id })).map((r) => r.id), query).not.toContain(bottle.id);
      expect((await searchBottles(db, query)).map((r) => r.id), query).not.toContain(bottle.id);
      expect((await searchBottles(db, query, { viewerId: alice.id })).map((r) => r.id), query).toContain(bottle.id);
    }
  });
});

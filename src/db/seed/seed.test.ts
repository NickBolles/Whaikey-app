import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb } from "@/test/helpers";
import type { DB } from "@/db";
import { WHISKEY_CATEGORIES, bottleAliases, bottles, bottleUpcs, distilleries } from "@/db/schema";
import { WEDGE_IDS } from "@/lib/flavor-wheel";
import { isValidUpc, resolveUpc } from "@/lib/scan";
import { seedDatabase } from "./index";

describe("seedDatabase", () => {
  let db: DB;

  beforeEach(async () => {
    db = await setupTestDb();
    await seedDatabase(db);
  });

  it("seeds a substantial catalog", async () => {
    const allDistilleries = await db.select().from(distilleries);
    const allBottles = await db.select().from(bottles);
    const allAliases = await db.select().from(bottleAliases);

    expect(allDistilleries.length).toBeGreaterThanOrEqual(95);
    expect(allBottles.length).toBeGreaterThanOrEqual(250);
    expect(allAliases.length).toBeGreaterThanOrEqual(60);
  });

  it("gives every bottle a valid category", async () => {
    const allBottles = await db.select().from(bottles);
    for (const bottle of allBottles) {
      expect(WHISKEY_CATEGORIES, `category of ${bottle.id}`).toContain(bottle.category);
    }
  });

  it("covers the major categories", async () => {
    const allBottles = await db.select().from(bottles);
    const byCategory = new Map<string, number>();
    for (const bottle of allBottles) {
      byCategory.set(bottle.category, (byCategory.get(bottle.category) ?? 0) + 1);
    }
    expect(byCategory.get("bourbon") ?? 0).toBeGreaterThanOrEqual(55);
    expect(byCategory.get("rye") ?? 0).toBeGreaterThanOrEqual(20);
    expect(byCategory.get("scotch-single-malt") ?? 0).toBeGreaterThanOrEqual(55);
    expect(byCategory.get("scotch-blended") ?? 0).toBeGreaterThanOrEqual(15);
    expect(byCategory.get("irish") ?? 0).toBeGreaterThanOrEqual(20);
    expect(byCategory.get("japanese") ?? 0).toBeGreaterThanOrEqual(15);
    expect(byCategory.get("canadian") ?? 0).toBeGreaterThanOrEqual(20);
  });

  it("gives every bottle a flavor profile over valid wedges with 0-10 scores", async () => {
    const allBottles = await db.select().from(bottles);
    for (const bottle of allBottles) {
      expect(bottle.flavorProfile, `flavorProfile of ${bottle.id}`).toBeTruthy();
      const entries = Object.entries(bottle.flavorProfile!);
      expect(entries.length, `flavorProfile keys of ${bottle.id}`).toBeGreaterThan(0);
      for (const [wedgeId, score] of entries) {
        expect(WEDGE_IDS, `wedge "${wedgeId}" on ${bottle.id}`).toContain(wedgeId);
        expect(score, `score for ${wedgeId} on ${bottle.id}`).toBeGreaterThanOrEqual(0);
        expect(score, `score for ${wedgeId} on ${bottle.id}`).toBeLessThanOrEqual(10);
      }
    }
  });

  it("resolves every bottle's distillery reference", async () => {
    const allDistilleries = await db.select().from(distilleries);
    const distilleryIds = new Set(allDistilleries.map((d) => d.id));
    const allBottles = await db.select().from(bottles);
    for (const bottle of allBottles) {
      if (bottle.distilleryId !== null) {
        expect(distilleryIds.has(bottle.distilleryId), `distillery of ${bottle.id}`).toBe(true);
      }
    }
  });

  it("resolves every alias to a seeded bottle", async () => {
    const bottleIds = new Set((await db.select().from(bottles)).map((b) => b.id));
    const allAliases = await db.select().from(bottleAliases);
    for (const alias of allAliases) {
      expect(bottleIds.has(alias.bottleId), `alias ${alias.alias}`).toBe(true);
    }
  });

  it("uses unique ids throughout", async () => {
    const distilleryIds = (await db.select().from(distilleries)).map((d) => d.id);
    const bottleIds = (await db.select().from(bottles)).map((b) => b.id);
    const aliasIds = (await db.select().from(bottleAliases)).map((a) => a.id);
    expect(new Set(distilleryIds).size).toBe(distilleryIds.length);
    expect(new Set(bottleIds).size).toBe(bottleIds.length);
    expect(new Set(aliasIds).size).toBe(aliasIds.length);
  });

  it("is idempotent: re-seeding keeps the same counts and rows", async () => {
    const before = {
      distilleries: (await db.select().from(distilleries)).length,
      bottles: (await db.select().from(bottles)).length,
      aliases: (await db.select().from(bottleAliases)).length,
      upcs: (await db.select().from(bottleUpcs)).length,
    };
    await seedDatabase(db);
    const after = {
      distilleries: (await db.select().from(distilleries)).length,
      bottles: (await db.select().from(bottles)).length,
      aliases: (await db.select().from(bottleAliases)).length,
      upcs: (await db.select().from(bottleUpcs)).length,
    };
    expect(after).toEqual(before);
  });

  it("seeds UPC mappings with valid check digits onto existing bottles", async () => {
    const bottleIds = new Set((await db.select().from(bottles)).map((b) => b.id));
    const upcRows = await db.select().from(bottleUpcs);
    expect(upcRows.length).toBeGreaterThanOrEqual(30);
    for (const row of upcRows) {
      expect(isValidUpc(row.upc), `check digit of ${row.upc} (${row.bottleId})`).toBe(true);
      expect(bottleIds.has(row.bottleId), `bottle of ${row.upc}`).toBe(true);
      expect(row.source).toBe("seed");
      expect(row.confirmedCount).toBe(0);
    }
    // No barcode maps to two bottles in the seed set.
    const codes = upcRows.map((r) => r.upc);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("spot-checks: scanning the Eagle Rare barcode resolves the bottle", async () => {
    const matches = await resolveUpc(db, "080244002145");
    expect(matches.map((m) => m.id)).toEqual(["eagle-rare-10"]);
  });

  it("re-seeding never clobbers a user-confirmed mapping", async () => {
    // A user has confirmed the seeded Eagle Rare code 3 times.
    await db
      .update(bottleUpcs)
      .set({ source: "user", confirmedCount: 3 })
      .where(eq(bottleUpcs.upc, "080244002145"));
    await seedDatabase(db);
    const [row] = await db.select().from(bottleUpcs).where(eq(bottleUpcs.upc, "080244002145"));
    expect(row.confirmedCount).toBe(3);
    expect(row.source).toBe("user");
  });

  it("spot-checks: Ardbeg 10 is heavily peaty", async () => {
    const [ardbeg] = await db.select().from(bottles).where(eq(bottles.id, "ardbeg-10"));
    expect(ardbeg).toBeTruthy();
    expect(ardbeg.category).toBe("scotch-single-malt");
    expect(ardbeg.region).toBe("Islay");
    expect(ardbeg.flavorProfile!.peaty).toBeGreaterThanOrEqual(7);
  });

  it("spot-checks: alias ECBP resolves to Elijah Craig Barrel Proof", async () => {
    const [row] = await db.select().from(bottleAliases).where(eq(bottleAliases.alias, "ECBP"));
    expect(row).toBeTruthy();
    const [bottle] = await db.select().from(bottles).where(eq(bottles.id, row.bottleId));
    expect(bottle.name).toBe("Elijah Craig Barrel Proof");
  });

  it("spot-checks: Macallan 12 Sherry Oak is fruity and sweet", async () => {
    const [mac] = await db.select().from(bottles).where(eq(bottles.id, "macallan-12-sherry"));
    expect(mac).toBeTruthy();
    expect(mac.flavorProfile!.fruity).toBeGreaterThanOrEqual(6);
    expect(mac.flavorProfile!.sweet).toBeGreaterThanOrEqual(6);
    expect(mac.caskTypes).toContain("oloroso sherry");
  });

  it("spot-checks: alias 'Weller SR' resolves to W.L. Weller Special Reserve", async () => {
    const [row] = await db.select().from(bottleAliases).where(eq(bottleAliases.alias, "Weller SR"));
    expect(row).toBeTruthy();
    expect(row.bottleId).toBe("weller-special-reserve");
    const [bottle] = await db.select().from(bottles).where(eq(bottles.id, row.bottleId));
    expect(bottle.name).toBe("W.L. Weller Special Reserve");
    expect(bottle.mashBill).toMatch(/wheat/i);
  });

  it("spot-checks: Wayne Gretzky Canadian resolves by alias 'WG Canadian'", async () => {
    const [row] = await db.select().from(bottleAliases).where(eq(bottleAliases.alias, "WG Canadian"));
    expect(row).toBeTruthy();
    const [bottle] = await db.select().from(bottles).where(eq(bottles.id, row.bottleId));
    expect(bottle.name).toBe("Wayne Gretzky No. 99 Red Cask");
    expect(bottle.category).toBe("canadian");
  });

  it("spot-checks: well-known bottles are present with sane data", async () => {
    const expected = [
      "buffalo-trace",
      "eagle-rare-10",
      "blantons-original",
      "makers-mark",
      "four-roses-single-barrel",
      "lagavulin-16",
      "laphroaig-10",
      "glenlivet-12",
      "redbreast-12",
      "yamazaki-12",
      "hibiki-harmony",
      "crown-royal",
    ];
    for (const id of expected) {
      const [bottle] = await db.select().from(bottles).where(eq(bottles.id, id));
      expect(bottle, id).toBeTruthy();
      expect(bottle.abv).toBeGreaterThan(35);
      expect(bottle.abv).toBeLessThan(75);
      expect(bottle.msrp).toBeGreaterThan(0);
      expect(bottle.avgPrice).toBeGreaterThan(0);
      expect(bottle.description!.length).toBeGreaterThan(10);
    }
  });
});

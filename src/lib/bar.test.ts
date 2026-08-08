import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { wedgeForLeaf } from "@/lib/flavor-wheel";
import { getBarFlavorHeat, getBarStats, getSpendByMonth, listUserBottles, monthKey } from "./bar";

async function seedUserBottle(
  db: DB,
  overrides: Partial<typeof schema.userBottles.$inferInsert> &
    Pick<typeof schema.userBottles.$inferInsert, "userId" | "bottleId" | "relationship">,
) {
  const [row] = await db
    .insert(schema.userBottles)
    .values({ id: uid("ub"), ...overrides })
    .returning();
  return row;
}

describe("getBarStats", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("computes counts, spend, value, and cost-per-pour", async () => {
    const user = await createTestUser(db);
    const other = await createTestUser(db);

    const bottleA = await createTestBottle(db, { name: "A", avgPrice: 60 });
    const bottleB = await createTestBottle(db, { name: "B", avgPrice: 200 });
    const bottleC = await createTestBottle(db, { name: "C", avgPrice: 40 });
    const bottleD = await createTestBottle(db, { name: "D", avgPrice: 999 });

    // Own, open, low fill, qty 2, no estValue -> falls back to avgPrice 60.
    const ub1 = await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottleA.id,
      relationship: "own",
      status: "open",
      fillLevel: 15,
      quantity: 2,
      purchasePrice: 50,
    });
    // Own, sealed, explicit estValue overrides avgPrice.
    const ub2 = await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottleB.id,
      relationship: "own",
      status: "sealed",
      fillLevel: 100,
      quantity: 1,
      purchasePrice: 100,
      estValue: 120,
    });
    // Another owned, open bottle contributes to counts and spend.
    const ub3 = await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottleC.id,
      relationship: "own",
      status: "open",
      fillLevel: 80,
      quantity: 1,
      purchasePrice: 30,
    });
    // Wishlist row must not count toward anything.
    await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottleD.id,
      relationship: "wishlist",
    });
    // Another user's bottle must not leak in.
    await seedUserBottle(db, {
      userId: other.id,
      bottleId: bottleA.id,
      relationship: "own",
      status: "open",
      fillLevel: 5,
      purchasePrice: 1000,
    });

    // Two pours against ub1, none against ub2/ub3.
    for (let i = 0; i < 2; i++) {
      await db.insert(schema.pours).values({
        id: uid("pour"),
        userId: user.id,
        bottleId: bottleA.id,
        userBottleId: ub1.id,
        rating: 4,
      });
    }
    // A pour with no userBottleId should be ignored by costPerPour.
    await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: user.id, bottleId: bottleC.id, rating: 3 });

    const stats = await getBarStats(db, user.id);

    expect(stats.bottleCount).toBe(3);
    expect(stats.openCount).toBe(2);
    expect(stats.sealedCount).toBe(1);
    // totalSpent multiplies quantity: 50*2 + 100*1 + 30*1
    expect(stats.totalSpent).toBe(230);
    // estValue: avgPrice fallback 60*2 + explicit 120*1 + fallback 40*1
    expect(stats.estValue).toBe(280);
    // avg over purchased quantity (4 bottles)
    expect(stats.avgBottlePrice).toBeCloseTo(230 / 4);
    // costPerPour divides by pour count (min 1)
    expect(stats.costPerPour[ub1.id]).toBeCloseTo(25);
    expect(stats.costPerPour[ub2.id]).toBeCloseTo(100);
    expect(stats.costPerPour[ub3.id]).toBeCloseTo(30);
  });


});

describe("getSpendByMonth", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("buckets the last 12 months of own purchases, zero-filled", async () => {
    const user = await createTestUser(db);
    const bottleA = await createTestBottle(db);
    const bottleB = await createTestBottle(db);
    const bottleC = await createTestBottle(db);
    const bottleD = await createTestBottle(db);

    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15));
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const thirteenMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 15));

    // qty 2 * $50 this month
    await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottleA.id,
      relationship: "own",
      purchasePrice: 50,
      quantity: 2,
      purchaseDate: thisMonth,
    });
    // $30 last month
    await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottleB.id,
      relationship: "own",
      purchasePrice: 30,
      purchaseDate: lastMonth,
    });
    // Too old — outside the 12-month window.
    await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottleC.id,
      relationship: "own",
      purchasePrice: 999,
      purchaseDate: thirteenMonthsAgo,
    });
    // Wishlist purchase data is ignored.
    await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottleD.id,
      relationship: "wishlist",
      purchasePrice: 500,
      purchaseDate: thisMonth,
    });

    const months = await getSpendByMonth(db, user.id, now);

    expect(months).toHaveLength(12);
    expect(months[11].month).toBe(monthKey(thisMonth));
    expect(months[11].total).toBe(100);
    expect(months[10].month).toBe(monthKey(lastMonth));
    expect(months[10].total).toBe(30);
    const grandTotal = months.reduce((sum, m) => sum + m.total, 0);
    expect(grandTotal).toBe(130);
  });
});

describe("listUserBottles", () => {
  it("joins bottle + distillery info and filters by relationship", async () => {
    const db = await setupTestDb();
    const user = await createTestUser(db);
    const [dist] = await db
      .insert(schema.distilleries)
      .values({ id: uid("dist"), name: "Buffalo Trace", country: "USA" })
      .returning();
    const bottle = await createTestBottle(db, {
      name: "Eagle Rare 10",
      distilleryId: dist.id,
      avgPrice: 45,
    });
    const bottle2 = await createTestBottle(db, { name: "Wish" });

    await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottle.id,
      relationship: "own",
      status: "sealed",
    });
    await seedUserBottle(db, { userId: user.id, bottleId: bottle2.id, relationship: "wishlist" });

    const own = await listUserBottles(db, user.id, { relationship: "own" });
    expect(own).toHaveLength(1);
    expect(own[0].bottle).toMatchObject({
      name: "Eagle Rare 10",
      category: "bourbon",
      distilleryName: "Buffalo Trace",
      avgPrice: 45,
    });

    const all = await listUserBottles(db, user.id);
    expect(all).toHaveLength(2);
  });
});

describe("getBarFlavorHeat", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("returns empty heat for a user with no bottles or notes", async () => {
    const user = await createTestUser(db);
    const heat = await getBarFlavorHeat(db, user.id);
    expect(heat.hasHeat).toBe(false);
    expect(heat.wedges).toEqual({});
    expect(heat.leaves).toEqual({});
    expect(heat.topWedgeIds).toEqual([]);
  });

  it("fills the personal bar wheel from owned bottle profiles before notes exist", async () => {
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db, { flavorProfile: { sweet: 8, woody: 4 } });
    await seedUserBottle(db, { userId: user.id, bottleId: bottle.id, relationship: "own" });

    const heat = await getBarFlavorHeat(db, user.id, "personal");

    expect(heat.hasHeat).toBe(true);
    expect(heat.wedges).toEqual({ sweet: 1, woody: 0.5 });
    expect(heat.leaves).toEqual({});
  });

  it("keeps the bar's personal notes and published bottle notes as separate sources", async () => {
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db, {
      flavorProfile: { sweet: 8, woody: 5 },
      producerFlavorTags: { vanilla: 3, oak: 2 },
      producerFlavorSourceUrl: "https://example.com/tasting-notes",
      producerFlavorSourceLabel: "Producer tasting notes",
    });
    await seedUserBottle(db, { userId: user.id, bottleId: bottle.id, relationship: "own" });
    const [pour] = await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: user.id, bottleId: bottle.id })
      .returning();
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: pour.id,
      flavorTags: { campfire: 3 },
      extractedBy: "user",
    });

    const personal = await getBarFlavorHeat(db, user.id, "personal");
    const published = await getBarFlavorHeat(db, user.id, "producer");

    expect(personal.leaves).toEqual({ campfire: 1 });
    expect(personal.wedges.peaty).toBe(1);
    expect(personal.wedges.sweet).toBe(1);
    expect(published.leaves).toEqual({ vanilla: 1, oak: expect.any(Number) });
    expect(published.leaves.campfire).toBeUndefined();
    expect(published.wedges.sweet).toBe(1);
  });

  it("does not present unattributed catalog descriptors as producer notes", async () => {
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db, { producerFlavorTags: { vanilla: 3 } });
    await seedUserBottle(db, { userId: user.id, bottleId: bottle.id, relationship: "own" });

    expect(await getBarFlavorHeat(db, user.id, "producer")).toMatchObject({
      hasHeat: false,
      wedges: {},
      leaves: {},
    });
  });

  it("sums owned bottles' wedge profiles, normalized to the hottest wedge", async () => {
    const user = await createTestUser(db);
    const peaty = await createTestBottle(db, { flavorProfile: { peaty: 10, fruity: 2 } });
    const peaty2 = await createTestBottle(db, { flavorProfile: { peaty: 6, sweet: 4 } });
    await seedUserBottle(db, { userId: user.id, bottleId: peaty.id, relationship: "own" });
    await seedUserBottle(db, { userId: user.id, bottleId: peaty2.id, relationship: "own" });

    const heat = await getBarFlavorHeat(db, user.id);
    // peaty total 16 is the max -> 1; fruity 2/16, sweet 4/16.
    expect(heat.wedges.peaty).toBe(1);
    expect(heat.wedges.fruity).toBeCloseTo(0.13, 2);
    expect(heat.wedges.sweet).toBeCloseTo(0.25, 2);
    expect(heat.topWedgeIds[0]).toBe("peaty");
    expect(heat.hasHeat).toBe(true);
    // No notes -> no leaf heat.
    expect(heat.leaves).toEqual({});
  });

  it("wishlist/tried bottles and other users' bars contribute no wedge heat", async () => {
    const user = await createTestUser(db);
    const other = await createTestUser(db);
    const bottle = await createTestBottle(db, { flavorProfile: { woody: 8 } });
    await seedUserBottle(db, { userId: user.id, bottleId: bottle.id, relationship: "wishlist" });
    await seedUserBottle(db, { userId: other.id, bottleId: bottle.id, relationship: "own" });

    const heat = await getBarFlavorHeat(db, user.id);
    expect(heat.hasHeat).toBe(false);
  });

  it("tasting-note flavor tags add leaf heat and warm the parent wedge", async () => {
    const user = await createTestUser(db);
    // A tried bottle with no profile: all heat must come from notes.
    const bottle = await createTestBottle(db, { flavorProfile: null });
    await seedUserBottle(db, { userId: user.id, bottleId: bottle.id, relationship: "tried" });

    const [pour] = await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: user.id, bottleId: bottle.id, rating: 4 })
      .returning();
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: pour.id,
      flavorTags: { campfire: 3, brine: 1, vanilla: 2 },
      extractedBy: "user",
    });

    const heat = await getBarFlavorHeat(db, user.id);
    const personalHeat = await getBarFlavorHeat(db, user.id, "personal", "own");
    // Leaves normalize to campfire (3): brine 1/3, vanilla 2/3.
    expect(heat.leaves.campfire).toBe(1);
    expect(heat.leaves.brine).toBeCloseTo(0.33, 2);
    expect(heat.leaves.vanilla).toBeCloseTo(0.67, 2);
    // Wedges: peaty (campfire+brine) outweighs sweet (vanilla) -> peaty is max.
    expect(heat.wedges.peaty).toBe(1);
    expect(heat.topWedgeIds[0]).toBe("peaty");
    // Sweet is floored at vanilla's own heat rather than its lower rolled-up
    // share, so the wheel never paints a hot leaf inside a colder family.
    expect(heat.wedges.sweet).toBe(heat.leaves.vanilla);
    // The personal My Bar view filters and displays the same owned-bottle
    // universe as the inventory list, so tried-only notes stay out of it.
    expect(personalHeat).toMatchObject({ hasHeat: false, wedges: {}, leaves: {} });
  });

  it("never renders a wedge colder than its own hottest leaf", async () => {
    const user = await createTestUser(db);
    // A bourbon-heavy shelf: sweet/woody accumulate across every bottle while
    // the single peated bottle contributes once.
    const profiles: Array<Record<string, number>> = [
      { sweet: 7, woody: 7, fruity: 4 },
      { sweet: 7, woody: 5, fruity: 5 },
      { sweet: 6, woody: 4, fruity: 7 },
      { peaty: 9, sweet: 5, fruity: 5 },
    ];
    for (const profile of profiles) {
      const bottle = await createTestBottle(db, { flavorProfile: profile });
      await seedUserBottle(db, { userId: user.id, bottleId: bottle.id, relationship: "own" });
    }
    // ...but the drinker's notes are overwhelmingly about the peated one,
    // tasted somewhere else and never bought.
    const noted = await createTestBottle(db, { flavorProfile: null });
    await seedUserBottle(db, { userId: user.id, bottleId: noted.id, relationship: "tried" });
    const [pour] = await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: user.id, bottleId: noted.id, rating: 5 })
      .returning();
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: pour.id,
      flavorTags: { campfire: 3, brine: 2 },
      extractedBy: "user",
    });

    const heat = await getBarFlavorHeat(db, user.id);
    expect(heat.leaves.campfire).toBe(1);
    // Summing raw wedge scores alone would leave peaty dim under the wheel's
    // brightest leaf; the floor keeps the two rings consistent.
    expect(heat.wedges.peaty).toBe(1);
    for (const [leafId, leafHeat] of Object.entries(heat.leaves)) {
      const wedgeId = wedgeForLeaf(leafId)!;
      expect(heat.wedges[wedgeId]).toBeGreaterThanOrEqual(leafHeat);
    }
  });

  it("weighs a pour's note against a bottle profile on the same 0-10 scale", async () => {
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db, { flavorProfile: { woody: 10 } });
    await seedUserBottle(db, { userId: user.id, bottleId: bottle.id, relationship: "own" });

    const [pour] = await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: user.id, bottleId: bottle.id, rating: 4 })
      .returning();
    // rollUpToWedges caps a 4-intensity tag set at the bottle scale's 10.
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: pour.id,
      flavorTags: { campfire: 3, peat: 1 },
      extractedBy: "user",
    });

    const heat = await getBarFlavorHeat(db, user.id);
    // Raw 1-3 intensities would have made peaty 4/14 = 0.29 against the bottle;
    // rolled up it matches the bottle's 10, so a logged pour actually shows.
    expect(heat.wedges.peaty).toBe(1);
    expect(heat.wedges.woody).toBe(1);
  });

  it("ignores another user's notes and unknown leaf ids", async () => {
    const user = await createTestUser(db);
    const other = await createTestUser(db);
    const bottle = await createTestBottle(db, { flavorProfile: null });
    await seedUserBottle(db, { userId: user.id, bottleId: bottle.id, relationship: "tried" });
    await seedUserBottle(db, { userId: other.id, bottleId: bottle.id, relationship: "tried" });

    const [mine] = await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: user.id, bottleId: bottle.id })
      .returning();
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: mine.id,
      flavorTags: { oak: 2, "not-a-real-leaf": 9 },
      extractedBy: "user",
    });

    const [theirs] = await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: other.id, bottleId: bottle.id })
      .returning();
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: theirs.id,
      flavorTags: { campfire: 3 },
      extractedBy: "user",
    });

    const heat = await getBarFlavorHeat(db, user.id);
    expect(heat.leaves).toEqual({ oak: 1 });
    expect(heat.wedges).toEqual({ woody: 1 });
  });

  describe("scope", () => {
    /** An owned sweet bottle and a tried oaky one, each with a matching note. */
    async function seedShelves(userId: string) {
      const owned = await createTestBottle(db, { flavorProfile: { sweet: 10 } });
      const tried = await createTestBottle(db, { flavorProfile: { woody: 10 } });
      await seedUserBottle(db, { userId, bottleId: owned.id, relationship: "own" });
      await seedUserBottle(db, { userId, bottleId: tried.id, relationship: "tried" });
      for (const [bottleId, tags] of [
        [owned.id, { vanilla: 3 }],
        [tried.id, { oak: 3 }],
      ] as const) {
        const [pour] = await db
          .insert(schema.pours)
          .values({ id: uid("pour"), userId, bottleId })
          .returning();
        await db
          .insert(schema.tastingNotes)
          .values({ id: uid("note"), pourId: pour.id, flavorTags: tags, extractedBy: "user" });
      }
      return { owned, tried };
    }

    it("limits the owned scope to bottles on the shelf", async () => {
      const user = await createTestUser(db);
      await seedShelves(user.id);

      const heat = await getBarFlavorHeat(db, user.id, "personal", "own");
      expect(heat.leaves).toEqual({ vanilla: 1 });
      expect(heat.wedges.woody).toBeUndefined();
    });

    it("limits the tried scope to bottles tasted but not owned", async () => {
      const user = await createTestUser(db);
      await seedShelves(user.id);

      const heat = await getBarFlavorHeat(db, user.id, "personal", "tried");
      expect(heat.leaves).toEqual({ oak: 1 });
      expect(heat.wedges.sweet).toBeUndefined();
      expect(heat.wedges.woody).toBe(1);
    });

    it("spans both shelves in the all scope", async () => {
      const user = await createTestUser(db);
      await seedShelves(user.id);

      const heat = await getBarFlavorHeat(db, user.id, "personal", "all");
      expect(heat.leaves).toEqual({ vanilla: 1, oak: 1 });
      expect(heat.wedges.sweet).toBe(1);
      expect(heat.wedges.woody).toBe(1);
    });

    it("never counts a wishlist bottle, which has not been tasted", async () => {
      const user = await createTestUser(db);
      const wished = await createTestBottle(db, { flavorProfile: { peaty: 10 } });
      await seedUserBottle(db, { userId: user.id, bottleId: wished.id, relationship: "wishlist" });

      for (const scope of ["own", "tried", "all"] as const) {
        expect(await getBarFlavorHeat(db, user.id, "personal", scope)).toMatchObject({
          hasHeat: false,
        });
      }
    });

    it("scopes producer notes too, so 'have I tried anything oaky' is answerable", async () => {
      const user = await createTestUser(db);
      const tried = await createTestBottle(db, {
        flavorProfile: null,
        producerFlavorTags: { oak: 3 },
        producerFlavorSourceUrl: "https://example.com/notes",
        producerFlavorSourceLabel: "Producer tasting notes",
      });
      await seedUserBottle(db, { userId: user.id, bottleId: tried.id, relationship: "tried" });

      expect(await getBarFlavorHeat(db, user.id, "producer", "own")).toMatchObject({
        hasHeat: false,
      });
      expect((await getBarFlavorHeat(db, user.id, "producer", "tried")).leaves).toEqual({ oak: 1 });
    });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { getBarStats, getSpendByMonth, listUserBottles, monthKey } from "./bar";

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
  beforeEach(() => {
    db = setupTestDb();
  });

  it("computes counts, spend, value, cost-per-pour and kill list", async () => {
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
    // Own, open but healthy fill -> not on kill list.
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
    // kill list: own + open + fillLevel <= 20 only
    expect(stats.killList).toEqual([
      { userBottleId: ub1.id, bottleId: bottleA.id, bottleName: "A", fillLevel: 15 },
    ]);
  });

  it("includes bottles at exactly the 20% threshold and excludes finished ones", async () => {
    const user = await createTestUser(db);
    const bottleA = await createTestBottle(db, { name: "Edge" });
    const bottleB = await createTestBottle(db, { name: "Done" });

    const edge = await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottleA.id,
      relationship: "own",
      status: "open",
      fillLevel: 20,
    });
    await seedUserBottle(db, {
      userId: user.id,
      bottleId: bottleB.id,
      relationship: "own",
      status: "finished",
      fillLevel: 0,
    });

    const stats = await getBarStats(db, user.id);
    expect(stats.killList.map((k) => k.userBottleId)).toEqual([edge.id]);
    expect(stats.totalSpent).toBe(0);
    expect(stats.avgBottlePrice).toBe(0);
  });
});

describe("getSpendByMonth", () => {
  let db: DB;
  beforeEach(() => {
    db = setupTestDb();
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
    const db = setupTestDb();
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

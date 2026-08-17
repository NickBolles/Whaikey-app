import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { getDashboard } from "./dashboard";

const NOW = new Date("2026-07-19T19:30:00Z");

async function seedPour(
  db: DB,
  userId: string,
  bottleId: string,
  createdAt: string,
  flavorTags?: Record<string, number>,
  rating?: number,
) {
  const [pour] = await db
    .insert(schema.pours)
    .values({ id: uid("pour"), userId, bottleId, rating, createdAt: new Date(createdAt) })
    .returning();
  if (flavorTags) {
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: pour.id,
      flavorTags,
      createdAt: new Date(createdAt),
    });
  }
  return pour;
}

describe("getDashboard", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("measures the month in descriptors named, never in pours poured", async () => {
    const user = await createTestUser(db);
    const bottleA = await createTestBottle(db, { name: "A" });
    const bottleB = await createTestBottle(db, { name: "B" });
    // Two bottles, four distinct descriptors this month (vanilla named twice).
    await seedPour(db, user.id, bottleA.id, "2026-07-02T12:00:00Z", { vanilla: 2, oak: 1 });
    await seedPour(db, user.id, bottleA.id, "2026-07-10T12:00:00Z", { vanilla: 3 });
    await seedPour(db, user.id, bottleB.id, "2026-07-12T12:00:00Z", { peat: 2, brine: 1 });
    await seedPour(db, user.id, bottleA.id, "2026-06-20T12:00:00Z", { honey: 2 });
    const other = await createTestUser(db);
    await seedPour(db, other.id, bottleA.id, "2026-07-05T12:00:00Z", { cherry: 3 });

    const data = await getDashboard(db, user.id, NOW);
    expect(data.monthName).toBe("July");
    expect(data.prevMonthName).toBe("June");
    expect(data.descriptorsNamed).toBe(4);
    expect(data.bottlesNoted).toBe(2);
    expect(data.hadPrevMonth).toBe(true);

    // Nothing on the shape counts or compares pour frequency.
    expect(data).not.toHaveProperty("pourCount");
    expect(data).not.toHaveProperty("pourDelta");
  });

  it("ranks this month's flavor families and names the one that rose most", async () => {
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "A" });
    // June: sweet-led. July: peaty overtakes — peaty is the riser.
    await seedPour(db, user.id, bottle.id, "2026-06-10T12:00:00Z", { vanilla: 3, campfire: 1 });
    await seedPour(db, user.id, bottle.id, "2026-07-08T12:00:00Z", { campfire: 3, peat: 2 });
    await seedPour(db, user.id, bottle.id, "2026-07-12T12:00:00Z", { vanilla: 2, brine: 1 });

    const data = await getDashboard(db, user.id, NOW);
    expect(data.topCategories[0]).toEqual({ wedgeId: "peaty", sharePct: 75 });
    expect(data.topCategories[1]).toEqual({ wedgeId: "sweet", sharePct: 25 });
    expect(data.risingWedgeId).toBe("peaty");
  });

  it("falls back to this month's top family when last month is silent", async () => {
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "A" });
    await seedPour(db, user.id, bottle.id, "2026-07-08T12:00:00Z", { honey: 2 });

    const data = await getDashboard(db, user.id, NOW);
    expect(data.hadPrevMonth).toBe(false);
    expect(data.risingWedgeId).toBe("sweet");
    expect(data.descriptorsNamed).toBe(1);
  });

  it("lists open bottles under 30% by level, lowest first, with no pour countdown", async () => {
    const user = await createTestUser(db);
    const low = await createTestBottle(db, { name: "Nearly Gone" });
    const lower = await createTestBottle(db, { name: "Fumes" });
    const fine = await createTestBottle(db, { name: "Plenty" });
    const sealed = await createTestBottle(db, { name: "Sealed" });
    const values = (bottleId: string, extra: Partial<typeof schema.userBottles.$inferInsert>) => ({
      id: uid("ub"),
      userId: user.id,
      bottleId,
      relationship: "own" as const,
      ...extra,
    });
    await db.insert(schema.userBottles).values([
      values(low.id, { status: "open", fillLevel: 25 }),
      values(lower.id, { status: "open", fillLevel: 10 }),
      values(fine.id, { status: "open", fillLevel: 80 }),
      values(sealed.id, { status: "sealed", fillLevel: 100 }),
    ]);

    const data = await getDashboard(db, user.id, NOW);
    expect(data.runningLow.map((r) => r.name)).toEqual(["Fumes", "Nearly Gone"]);
    expect(data.runningLow.map((r) => r.fillLevel)).toEqual([10, 25]);
    // "How many pours are left in it" is a target to finish, so it is absent.
    expect(data.runningLow[0]).not.toHaveProperty("poursLeft");
    expect(data.shelfTotal).toBe(4);
  });

  it("reports no agreement before any label comparison exists", async () => {
    const user = await createTestUser(db);
    const data = await getDashboard(db, user.id, NOW);
    expect(data.agreement).toBeNull();
    expect(data.descriptorsNamed).toBe(0);
    expect(data.bottlesNoted).toBe(0);
    expect(data.topCategories).toEqual([]);
    expect(data.risingWedgeId).toBeNull();
  });

  it("counts bottles added this month against the shelf total", async () => {
    const user = await createTestUser(db);
    const a = await createTestBottle(db, { name: "A" });
    const b = await createTestBottle(db, { name: "B" });
    await db.insert(schema.userBottles).values([
      {
        id: uid("ub"),
        userId: user.id,
        bottleId: a.id,
        relationship: "own",
        createdAt: new Date("2026-07-03T12:00:00Z"),
      },
      {
        id: uid("ub"),
        userId: user.id,
        bottleId: b.id,
        relationship: "own",
        createdAt: new Date("2026-04-03T12:00:00Z"),
      },
    ]);

    const data = await getDashboard(db, user.id, NOW);
    expect(data.newBottles).toBe(1);
    expect(data.shelfTotal).toBe(2);
  });
});

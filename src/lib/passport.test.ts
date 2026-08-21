import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { passportTiers, pours, userBottles } from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  PASSPORT_TIER_SPECS,
  bottlesForTier,
  getPassport,
  getPassportBadgeDetail,
  tierForCount,
} from "./passport";

let db: DB;
let userId: string;

beforeEach(async () => {
  db = await setupTestDb();
  const user = await createTestUser(db);
  userId = user.id;
});

async function seedIslay(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const bottle = await createTestBottle(db, {
      name: `Islay Malt ${i}`,
      category: "scotch-single-malt",
      country: "Scotland",
      region: "Islay",
    });
    ids.push(bottle.id);
  }
  return ids;
}

async function tryBottle(bottleId: string): Promise<void> {
  await db.insert(userBottles).values({ id: uid("ub"), userId, bottleId, relationship: "tried" });
}

describe("tier math", () => {
  it("scales thresholds as a share of the catalog with absolute floors", () => {
    const [oak, copper, silver, gold, amber] = PASSPORT_TIER_SPECS;
    // Big catalog: the percentage dominates.
    expect(bottlesForTier(amber, 100)).toBe(80);
    expect(bottlesForTier(gold, 100)).toBe(50);
    // Small catalog: the floor dominates, so a 1-bottle country caps at Oak.
    expect(bottlesForTier(oak, 1)).toBe(1);
    expect(bottlesForTier(copper, 1)).toBe(3);
    expect(bottlesForTier(silver, 6)).toBe(6);
  });

  it("earns tiers only when both the share and the floor are cleared", () => {
    expect(tierForCount(0, 24)).toBe(0);
    expect(tierForCount(1, 24)).toBe(1);
    expect(tierForCount(6, 24)).toBe(3); // 25% of 24 and the 6-bottle floor
    expect(tierForCount(11, 24)).toBe(3); // 50% needs 12
    expect(tierForCount(24, 24)).toBe(5);
    // Everything a tiny catalog offers still caps at the floor's tier.
    expect(tierForCount(1, 1)).toBe(1);
    expect(tierForCount(5, 5)).toBe(2);
  });
});

describe("getPassport", () => {
  it("counts distinct met bottles — repeat pours advance nothing", async () => {
    const [a] = await seedIslay(10);
    for (let i = 0; i < 5; i++) {
      await db.insert(pours).values({ id: uid("pour"), userId, bottleId: a, amountMl: 15 });
    }
    const passport = await getPassport(db, userId);
    const islay = passport.regions.find((b) => b.value === "Islay");
    expect(islay).toMatchObject({ metCount: 1, catalogTotal: 10, currentTier: 1 });
    const scotland = passport.countries.find((b) => b.value === "Scotland");
    expect(scotland?.metCount).toBe(1);
  });

  it("counts a pour-only bottle and an own/tried bottle once each; wishlist never", async () => {
    const [a, b, c] = await seedIslay(10);
    await db.insert(pours).values({ id: uid("pour"), userId, bottleId: a });
    await tryBottle(b);
    await db.insert(userBottles).values({ id: uid("ub"), userId, bottleId: c, relationship: "wishlist" });
    // Met via both paths at once still counts once.
    await db.insert(pours).values({ id: uid("pour"), userId, bottleId: b });

    const passport = await getPassport(db, userId);
    expect(passport.regions.find((r) => r.value === "Islay")?.metCount).toBe(2);
  });

  it("excludes unverified bottles from the denominator", async () => {
    const ids = await seedIslay(6);
    await createTestBottle(db, { name: "COLA ghost", country: "Scotland", region: "Islay", status: "imported" });
    await tryBottle(ids[0]);
    const passport = await getPassport(db, userId);
    expect(passport.regions.find((r) => r.value === "Islay")?.catalogTotal).toBe(6);
  });

  it("stamps newly-earned tiers for the owner and never downgrades when the catalog grows", async () => {
    const ids = await seedIslay(6);
    for (const bottleId of ids) await tryBottle(bottleId);

    // 6 of 6 = 100% but the Gold floor is 12, so Silver III is the ceiling.
    let passport = await getPassport(db, userId, { stampNewTiers: true });
    let islay = passport.regions.find((r) => r.value === "Islay");
    expect(islay?.currentTier).toBe(3);
    expect(islay?.heldTier).toBe(3);
    expect(islay?.achievedAt[1]).toBeInstanceOf(Date);
    expect(islay?.achievedAt[3]).toBeInstanceOf(Date);

    // The catalog quintuples: 6 of 30 clears 10% but not 25%, so the current
    // share collapses to Copper II — the held tier does not move.
    await seedIslay(24);
    passport = await getPassport(db, userId, { stampNewTiers: true });
    islay = passport.regions.find((r) => r.value === "Islay");
    expect(islay?.currentTier).toBe(2);
    expect(islay?.heldTier).toBe(3);
    expect(islay?.achievedAt[3]).toBeInstanceOf(Date);
  });

  it("does not write tier rows for other viewers", async () => {
    const ids = await seedIslay(3);
    await tryBottle(ids[0]);
    await getPassport(db, userId);
    const rows = await db.select().from(passportTiers).where(eq(passportTiers.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it("stamping is idempotent", async () => {
    const ids = await seedIslay(3);
    await tryBottle(ids[0]);
    await getPassport(db, userId, { stampNewTiers: true });
    await getPassport(db, userId, { stampNewTiers: true });
    const rows = await db.select().from(passportTiers).where(eq(passportTiers.userId, userId));
    // Oak I for the region, the country, and the style — exactly once each.
    expect(rows).toHaveLength(3);
  });
});

describe("getPassportBadgeDetail", () => {
  it("lists distinct bottles with first-met date, latest rating and pour count", async () => {
    const [a, b] = await seedIslay(8);
    await db
      .insert(pours)
      .values({ id: uid("pour"), userId, bottleId: a, rating: 3.5, createdAt: new Date("2026-01-05") });
    await db
      .insert(pours)
      .values({ id: uid("pour"), userId, bottleId: a, rating: 4.5, createdAt: new Date("2026-03-01") });
    await tryBottle(b);

    const detail = await getPassportBadgeDetail(db, userId, "region", "Islay");
    expect(detail).not.toBeNull();
    expect(detail!.badge.metCount).toBe(2);
    expect(detail!.bottles).toHaveLength(2);
    const bottleA = detail!.bottles.find((row) => row.bottleId === a);
    expect(bottleA).toMatchObject({ rating: 4.5, pourCount: 2 });
    expect(bottleA!.firstMetAt.toISOString().slice(0, 10)).toBe("2026-01-05");
  });

  it("resolves style badges through the category column", async () => {
    const bottle = await createTestBottle(db, { name: "Test Rye", category: "rye", country: "USA" });
    await tryBottle(bottle.id);
    const detail = await getPassportBadgeDetail(db, userId, "style", "rye");
    expect(detail?.badge.label).toBe("Rye");
    expect(detail?.bottles.map((row) => row.name)).toEqual(["Test Rye"]);
  });

  it("returns null for a badge the user has never met", async () => {
    expect(await getPassportBadgeDetail(db, userId, "region", "Islay")).toBeNull();
  });
});

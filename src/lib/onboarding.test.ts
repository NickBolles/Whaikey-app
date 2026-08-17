import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { needsOnboarding, ONBOARDING_COOKIE } from "@/lib/onboarding";

describe("onboarding", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it("exports the shared cookie name Agent B keys the Home redirect off", () => {
    expect(ONBOARDING_COOKIE).toBe("whaikey_onboarded");
  });

  it("is true for a brand-new user with no profile, bottles, or pours", async () => {
    const db = getDb();
    const user = await createTestUser(db);
    await expect(needsOnboarding(db, user.id)).resolves.toBe(true);
  });

  it("is false once the user has claimed a profile", async () => {
    const db = getDb();
    const user = await createTestUser(db);
    await db.insert(schema.userProfiles).values({
      userId: user.id,
      handle: "drammer",
      displayName: "Dram Fan",
    });
    await expect(needsOnboarding(db, user.id)).resolves.toBe(false);
  });

  it("is false once the user has any bar row (wishlist counts)", async () => {
    const db = getDb();
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db);
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: bottle.id,
      relationship: "wishlist",
    });
    await expect(needsOnboarding(db, user.id)).resolves.toBe(false);
  });

  it("is false once the user has logged a pour", async () => {
    const db = getDb();
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db);
    await db.insert(schema.pours).values({ id: uid("pour"), userId: user.id, bottleId: bottle.id });
    await expect(needsOnboarding(db, user.id)).resolves.toBe(false);
  });

  it("ignores other users' data", async () => {
    const db = getDb();
    const veteran = await createTestUser(db);
    const newcomer = await createTestUser(db);
    const bottle = await createTestBottle(db);
    await db.insert(schema.userProfiles).values({
      userId: veteran.id,
      handle: "oldhand",
      displayName: "Old Hand",
    });
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: veteran.id,
      bottleId: bottle.id,
      relationship: "own",
    });
    await db.insert(schema.pours).values({ id: uid("pour"), userId: veteran.id, bottleId: bottle.id });

    await expect(needsOnboarding(db, newcomer.id)).resolves.toBe(true);
    await expect(needsOnboarding(db, veteran.id)).resolves.toBe(false);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "./index";
import * as schema from "./schema";
import { createTestBottle, createTestUser, setupTestDb } from "@/test/helpers";

describe("database schema", () => {
  let db: DB;
  beforeEach(() => {
    db = setupTestDb();
  });

  it("migrates and supports the core domain flow", async () => {
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10", category: "bourbon" });

    const [ub] = await db
      .insert(schema.userBottles)
      .values({
        id: "ub1",
        userId: user.id,
        bottleId: bottle.id,
        relationship: "own",
        status: "open",
        fillLevel: 80,
        purchasePrice: 39.99,
      })
      .returning();
    expect(ub.relationship).toBe("own");

    const [pour] = await db
      .insert(schema.pours)
      .values({ id: "p1", userId: user.id, bottleId: bottle.id, userBottleId: ub.id, rating: 4.5 })
      .returning();

    await db.insert(schema.tastingNotes).values({
      id: "tn1",
      pourId: pour.id,
      nose: "Cherry and oak",
      flavorTags: { cherry: 2, oak: 3 },
    });

    const notes = await db.query.tastingNotes.findMany({
      where: eq(schema.tastingNotes.pourId, pour.id),
    });
    expect(notes[0].flavorTags).toEqual({ cherry: 2, oak: 3 });
  });

  it("enforces one user_bottle row per user+bottle", async () => {
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db);
    await db
      .insert(schema.userBottles)
      .values({ id: "a", userId: user.id, bottleId: bottle.id, relationship: "own" });
    await expect(
      db
        .insert(schema.userBottles)
        .values({ id: "b", userId: user.id, bottleId: bottle.id, relationship: "wishlist" }),
    ).rejects.toThrow();
  });

  it("cascades pour deletion from bottles", async () => {
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db);
    await db.insert(schema.pours).values({ id: "p1", userId: user.id, bottleId: bottle.id, rating: 4 });
    await db.delete(schema.bottles).where(eq(schema.bottles.id, bottle.id));
    const remaining = await db.query.pours.findMany();
    expect(remaining).toHaveLength(0);
  });
});

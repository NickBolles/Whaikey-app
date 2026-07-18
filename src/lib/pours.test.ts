import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  BottleNotFoundError,
  deletePour,
  fillDecrementFor,
  getPour,
  listPours,
  logPour,
} from "@/lib/pours";

async function createUserBottle(
  db: DB,
  userId: string,
  bottleId: string,
  overrides: Partial<typeof schema.userBottles.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.userBottles)
    .values({
      id: uid("ub"),
      userId,
      bottleId,
      relationship: "own",
      ...overrides,
    })
    .returning();
  return row;
}

describe("fillDecrementFor", () => {
  it("is ~3% per 30ml, rounded", () => {
    expect(fillDecrementFor(30)).toBe(3);
    expect(fillDecrementFor(45)).toBe(5); // 4.5 rounds up
    expect(fillDecrementFor(60)).toBe(6);
  });
});

describe("logPour", () => {
  let db: DB;
  let userId: string;
  let bottleId: string;

  beforeEach(async () => {
    db = await setupTestDb();
    userId = (await createTestUser(db)).id;
    bottleId = (await createTestBottle(db)).id;
  });

  it("creates a pour with defaults and no note", async () => {
    const { pour, note } = await logPour(db, userId, { bottleId, rating: 4.5 });
    expect(pour.id).toBeTruthy();
    expect(pour.userId).toBe(userId);
    expect(pour.bottleId).toBe(bottleId);
    expect(pour.rating).toBe(4.5);
    expect(pour.amountMl).toBe(45); // default pour
    expect(pour.userBottleId).toBeNull();
    expect(note).toBeNull();
  });

  it("links the user's bottle and decrements fill on an open bottle (45ml: 100 -> 95)", async () => {
    const ub = await createUserBottle(db, userId, bottleId, { status: "open", fillLevel: 100 });
    const { pour } = await logPour(db, userId, { bottleId, amountMl: 45 });
    expect(pour.userBottleId).toBe(ub.id);
    const updated = await db.query.userBottles.findFirst({
      where: eq(schema.userBottles.id, ub.id),
    });
    expect(updated?.fillLevel).toBe(95);
  });

  it("decrements 3 for a 30ml pour", async () => {
    const ub = await createUserBottle(db, userId, bottleId, { status: "open", fillLevel: 50 });
    await logPour(db, userId, { bottleId, amountMl: 30 });
    const updated = await db.query.userBottles.findFirst({
      where: eq(schema.userBottles.id, ub.id),
    });
    expect(updated?.fillLevel).toBe(47);
  });

  it("floors fill level at 0", async () => {
    const ub = await createUserBottle(db, userId, bottleId, { status: "open", fillLevel: 3 });
    await logPour(db, userId, { bottleId, amountMl: 60 });
    const updated = await db.query.userBottles.findFirst({
      where: eq(schema.userBottles.id, ub.id),
    });
    expect(updated?.fillLevel).toBe(0);
  });

  it("does not decrement a sealed bottle but still links it", async () => {
    const ub = await createUserBottle(db, userId, bottleId, { status: "sealed", fillLevel: 100 });
    const { pour } = await logPour(db, userId, { bottleId, amountMl: 60 });
    expect(pour.userBottleId).toBe(ub.id);
    const updated = await db.query.userBottles.findFirst({
      where: eq(schema.userBottles.id, ub.id),
    });
    expect(updated?.fillLevel).toBe(100);
  });

  it("does not touch another user's bottle row", async () => {
    const otherUser = await createTestUser(db);
    const otherUb = await createUserBottle(db, otherUser.id, bottleId, {
      status: "open",
      fillLevel: 100,
    });
    const { pour } = await logPour(db, userId, { bottleId });
    expect(pour.userBottleId).toBeNull();
    const untouched = await db.query.userBottles.findFirst({
      where: eq(schema.userBottles.id, otherUb.id),
    });
    expect(untouched?.fillLevel).toBe(100);
  });

  it("inserts a tasting note with flavor tags, extractedBy user", async () => {
    const { pour, note } = await logPour(db, userId, {
      bottleId,
      rating: 4,
      servingStyle: "neat",
      note: {
        nose: "Cherry cola and oak",
        palate: "Thick caramel",
        flavorTags: { vanilla: 3, cherry: 2, oak: 1 },
      },
    });
    expect(note).not.toBeNull();
    expect(note?.pourId).toBe(pour.id);
    expect(note?.nose).toBe("Cherry cola and oak");
    expect(note?.flavorTags).toEqual({ vanilla: 3, cherry: 2, oak: 1 });
    expect(note?.extractedBy).toBe("user");

    const stored = await db.query.tastingNotes.findFirst({
      where: eq(schema.tastingNotes.pourId, pour.id),
    });
    expect(stored?.flavorTags).toEqual({ vanilla: 3, cherry: 2, oak: 1 });
  });

  it("skips the note row when the note object is empty", async () => {
    const { note } = await logPour(db, userId, { bottleId, note: { nose: "   " } });
    expect(note).toBeNull();
    expect(await db.query.tastingNotes.findMany()).toHaveLength(0);
  });

  it("rejects invalid flavor leaf ids and writes nothing", async () => {
    await expect(
      logPour(db, userId, { bottleId, note: { flavorTags: { "not-a-leaf": 2 } } }),
    ).rejects.toThrow(/Unknown flavor leaf/);
    expect(await db.query.pours.findMany()).toHaveLength(0);
  });

  it("rejects out-of-range intensity", async () => {
    await expect(
      logPour(db, userId, { bottleId, note: { flavorTags: { vanilla: 4 } } }),
    ).rejects.toThrow(/Intensity/);
    await expect(
      logPour(db, userId, { bottleId, note: { flavorTags: { vanilla: 1.5 } } }),
    ).rejects.toThrow(/Intensity/);
  });

  it("rejects a rating that is not a half-star step", async () => {
    await expect(logPour(db, userId, { bottleId, rating: 4.3 })).rejects.toThrow();
    await expect(logPour(db, userId, { bottleId, rating: 5.5 })).rejects.toThrow();
    await expect(logPour(db, userId, { bottleId, rating: 0 })).rejects.toThrow();
  });

  it("throws BottleNotFoundError for an unknown bottle", async () => {
    await expect(logPour(db, userId, { bottleId: "nope", rating: 4 })).rejects.toThrow(
      BottleNotFoundError,
    );
  });
});

describe("listPours / getPour / deletePour", () => {
  let db: DB;
  let userId: string;
  let bottleId: string;

  beforeEach(async () => {
    db = await setupTestDb();
    userId = (await createTestUser(db)).id;
    bottleId = (await createTestBottle(db, { name: "Journal Bourbon" })).id;
  });

  it("lists own pours with bottle name and note, filtered by bottleId", async () => {
    const otherBottleId = (await createTestBottle(db, { name: "Other Rye", category: "rye" })).id;
    await logPour(db, userId, { bottleId, rating: 4, note: { flavorTags: { vanilla: 2 } } });
    await logPour(db, userId, { bottleId: otherBottleId, rating: 3 });

    const all = await listPours(db, userId);
    expect(all).toHaveLength(2);

    const filtered = await listPours(db, userId, { bottleId });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].bottleName).toBe("Journal Bourbon");
    expect(filtered[0].note?.flavorTags).toEqual({ vanilla: 2 });
  });

  it("never returns another user's pours", async () => {
    const other = await createTestUser(db);
    await logPour(db, other.id, { bottleId, rating: 5 });
    expect(await listPours(db, userId)).toHaveLength(0);
  });

  it("getPour scopes to the owner", async () => {
    const other = await createTestUser(db);
    const { pour } = await logPour(db, userId, { bottleId, note: { nose: "Honey" } });
    const mine = await getPour(db, userId, pour.id);
    expect(mine?.note?.nose).toBe("Honey");
    expect(await getPour(db, other.id, pour.id)).toBeNull();
  });

  it("deletePour removes the pour and its note, only for the owner", async () => {
    const other = await createTestUser(db);
    const { pour } = await logPour(db, userId, { bottleId, note: { nose: "Honey" } });

    expect(await deletePour(db, other.id, pour.id)).toBe(false);
    expect(await deletePour(db, userId, pour.id)).toBe(true);
    expect(await db.query.pours.findMany()).toHaveLength(0);
    expect(await db.query.tastingNotes.findMany()).toHaveLength(0);
  });
});

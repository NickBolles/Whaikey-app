import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { createPourShare, getPublicPourShare } from "@/lib/pour-sharing";

describe("pour sharing", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it("creates a stable short code and exposes only the intentional pour and note", async () => {
    const db = getDb();
    const owner = await createTestUser(db, { name: "Avery" });
    const bottle = await createTestBottle(db, { name: "Golden Oak" });
    const [pour] = await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: owner.id, bottleId: bottle.id, rating: 4.5, amountMl: 45 })
      .returning();
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: pour.id,
      nose: "Orange peel",
      palate: "Toasted oak",
      freeform: "A quiet nightcap.",
      flavorTags: { orange: 2, vanilla: 1 },
      extractedBy: "user",
    });

    const first = await createPourShare(db, owner.id, pour.id, { locationLabel: "Back porch" });
    const second = await createPourShare(db, owner.id, pour.id);
    if (!first || !second) throw new Error("Owner's pour should be shareable");
    expect(first.code).toMatch(/^[A-Za-z0-9_-]{10,}$/);
    expect(second.code).toBe(first.code);

    const shared = await getPublicPourShare(db, first.code);
    expect(shared).toMatchObject({
      code: first.code,
      ownerName: "Avery",
      bottleName: "Golden Oak",
      locationLabel: "Back porch",
      pour: { rating: 4.5, amountMl: 45 },
      note: { nose: "Orange peel", palate: "Toasted oak", freeform: "A quiet nightcap." },
    });
    expect(shared?.note.flavorTags).toEqual({ orange: 2, vanilla: 1 });
  });

  it("does not create or resolve links for another user's pour", async () => {
    const db = getDb();
    const owner = await createTestUser(db);
    const stranger = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const [pour] = await db.insert(schema.pours).values({ id: uid("pour"), userId: owner.id, bottleId: bottle.id }).returning();

    await expect(createPourShare(db, stranger.id, pour.id)).resolves.toBeNull();
    await expect(getPublicPourShare(db, "not-a-real-code")).resolves.toBeNull();
  });
});

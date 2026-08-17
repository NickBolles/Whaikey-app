import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { createPourShare, getPublicPourShare, listPourShares, revokePourShare } from "@/lib/pour-sharing";

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

  it("revoking a share makes it 404 immediately, and re-sharing mints a new code that keeps the old one dead", async () => {
    const db = getDb();
    const owner = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const [pour] = await db.insert(schema.pours).values({ id: uid("pour"), userId: owner.id, bottleId: bottle.id }).returning();

    const first = await createPourShare(db, owner.id, pour.id);
    if (!first) throw new Error("Owner's pour should be shareable");
    await expect(getPublicPourShare(db, first.code)).resolves.not.toBeNull();

    await expect(revokePourShare(db, owner.id, pour.id)).resolves.toBe(true);
    await expect(getPublicPourShare(db, first.code)).resolves.toBeNull();

    // Idempotent: revoking again is a no-op, not an error.
    await expect(revokePourShare(db, owner.id, pour.id)).resolves.toBe(true);

    const second = await createPourShare(db, owner.id, pour.id);
    if (!second) throw new Error("Re-sharing after revoke should succeed");
    expect(second.code).not.toBe(first.code);
    await expect(getPublicPourShare(db, second.code)).resolves.not.toBeNull();
    // The old, revoked code must stay dead even after re-sharing.
    await expect(getPublicPourShare(db, first.code)).resolves.toBeNull();
  });

  it("does not let a stranger revoke someone else's share", async () => {
    const db = getDb();
    const owner = await createTestUser(db);
    const stranger = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const [pour] = await db.insert(schema.pours).values({ id: uid("pour"), userId: owner.id, bottleId: bottle.id }).returning();
    const share = await createPourShare(db, owner.id, pour.id);
    if (!share) throw new Error("Owner's pour should be shareable");

    await expect(revokePourShare(db, stranger.id, pour.id)).resolves.toBe(false);
    await expect(getPublicPourShare(db, share.code)).resolves.not.toBeNull();

    // A pour that doesn't exist at all is the same 404 signal.
    await expect(revokePourShare(db, owner.id, "not-a-real-pour")).resolves.toBe(false);
  });

  it("listPourShares returns only active shares, excluding revoked ones", async () => {
    const db = getDb();
    const owner = await createTestUser(db);
    const bottleA = await createTestBottle(db, { name: "Alpha" });
    const bottleB = await createTestBottle(db, { name: "Bravo" });
    const [pourA] = await db.insert(schema.pours).values({ id: uid("pour"), userId: owner.id, bottleId: bottleA.id }).returning();
    const [pourB] = await db.insert(schema.pours).values({ id: uid("pour"), userId: owner.id, bottleId: bottleB.id }).returning();

    await createPourShare(db, owner.id, pourA.id);
    await createPourShare(db, owner.id, pourB.id);
    await revokePourShare(db, owner.id, pourB.id);

    const shares = await listPourShares(db, owner.id);
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ pourId: pourA.id, bottleId: bottleA.id, bottleName: "Alpha" });
  });
});

describe("step-back share gate (US-11)", () => {
  it("refuses to mint or reactivate a share while the owner is stepped back", async () => {
    const db = await setupTestDb();
    const user = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const [pour] = await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: user.id, bottleId: bottle.id, rating: 4 })
      .returning();
    await db.insert(schema.userProfiles).values({
      userId: user.id,
      handle: "steppedshare",
      displayName: "Stepped",
      socialEnabled: false,
    });
    await expect(createPourShare(db, user.id, pour.id)).rejects.toThrow("Social is turned off");
  });
});

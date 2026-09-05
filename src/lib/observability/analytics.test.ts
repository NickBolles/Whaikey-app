import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { recordEvent, recordShareConversion } from "./analytics";

/**
 * The contract this module states about itself: recording must not be able to
 * break the thing it is measuring. These are the tests for that sentence,
 * which did not exist while the sentence did.
 */

let db: DB;
beforeEach(async () => {
  db = await setupTestDb();
});

async function shareOf(ownerId: string, bottleId: string): Promise<string> {
  const pourId = uid("pour");
  await db.insert(schema.pours).values({ id: pourId, userId: ownerId, bottleId, visibility: "public" });
  const id = uid("share");
  await db.insert(schema.pourShares).values({ id, pourId, userId: ownerId, code: uid("code") });
  return id;
}

describe("recording a share conversion", () => {
  it("records the conversion when the share really is for that bottle", async () => {
    const owner = await createTestUser(db);
    const viewer = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const shareId = await shareOf(owner.id, bottle.id);

    await recordShareConversion(db, {
      shareId,
      bottleId: bottle.id,
      userId: viewer.id,
      relationship: "wishlist",
    });

    const events = await db.select().from(schema.analyticsEvents);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("share_wishlist_add");
  });

  it("refuses a share that is not about that bottle, and the sharer's own add", async () => {
    const owner = await createTestUser(db);
    const viewer = await createTestUser(db);
    const shared = await createTestBottle(db, { name: "Shared" });
    const other = await createTestBottle(db, { name: "Unrelated" });
    const shareId = await shareOf(owner.id, shared.id);

    // The id exists, so the foreign key is satisfied — which proves nothing.
    await recordShareConversion(db, {
      shareId,
      bottleId: other.id,
      userId: viewer.id,
      relationship: "wishlist",
    });
    // And the funnel is about recipients, not the person who made the link.
    await recordShareConversion(db, {
      shareId,
      bottleId: shared.id,
      userId: owner.id,
      relationship: "wishlist",
    });

    expect(await db.select().from(schema.analyticsEvents)).toHaveLength(0);
  });

  it("never lets a telemetry failure change the answer about the shelf", async () => {
    const owner = await createTestUser(db);
    const viewer = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const shareId = await shareOf(owner.id, bottle.id);

    /**
     * The validation query itself failing — a pool timeout, a reset. It used
     * to run unguarded in the route AFTER `upsertUserBottle` had committed, so
     * this became a 500: the person was told their bottle had not been added
     * when it had, and the retry then found the existing row, so `created` was
     * false and no conversion was recorded either. A lost metric is a
     * nuisance; a successful write reported as a failure is a lie to the user.
     */
    const broken = {
      select: () => {
        throw new Error("connection reset while resolving the share");
      },
    } as unknown as DB;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordShareConversion(broken, {
        shareId,
        bottleId: bottle.id,
        userId: viewer.id,
        relationship: "wishlist",
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("swallows a failed event write too, for the same reason", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      insert: () => {
        throw new Error("table is gone");
      },
    } as unknown as DB;
    await expect(recordEvent(broken, "share_view", { shareId: null })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

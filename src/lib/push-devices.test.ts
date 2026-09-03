import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb } from "@/test/helpers";
import { PUSH_TOKEN_CLAIM_DAYS, registerPushDevice } from "./push-devices";

/**
 * Review SEC-M6: registration reassigned a token to whoever POSTed it, so
 * anyone who learned a victim's APNs/FCM token took their notifications with
 * it. The token is the credential *and* the thing that leaks, so possession of
 * it cannot be proof of possession of the device.
 */
const TOKEN = "apns-token-abc123";
let db: DB;
let alice: schema.User;
let bob: schema.User;

const daysAgo = (days: number, from = new Date("2026-09-03T12:00:00Z")) =>
  new Date(from.getTime() - days * 24 * 60 * 60 * 1000);

beforeEach(async () => {
  db = await setupTestDb();
  alice = await createTestUser(db, { name: "Alice" });
  bob = await createTestUser(db, { name: "Bob" });
});

describe("registerPushDevice", () => {
  it("registers an unclaimed token", async () => {
    await expect(registerPushDevice(db, alice.id, TOKEN, "ios")).resolves.toBe("registered");
    const [row] = await db.select().from(schema.pushDevices);
    expect(row).toMatchObject({ userId: alice.id, token: TOKEN, platform: "ios" });
  });

  it("refreshes its owner's own token without complaint", async () => {
    await registerPushDevice(db, alice.id, TOKEN, "ios");
    await expect(registerPushDevice(db, alice.id, TOKEN, "ios")).resolves.toBe("registered");
    expect(await db.select().from(schema.pushDevices)).toHaveLength(1);
  });

  it("refuses to hand a live token to somebody else", async () => {
    const now = new Date("2026-09-03T12:00:00Z");
    await registerPushDevice(db, alice.id, TOKEN, "ios", now);

    await expect(registerPushDevice(db, bob.id, TOKEN, "ios", now)).resolves.toBe(
      "claimed_by_another",
    );
    const [row] = await db.select().from(schema.pushDevices);
    expect(row.userId).toBe(alice.id);
  });

  /**
   * The legitimate transfer: a phone handed on, or the app deleted and
   * reinstalled so the OS reissued the token, with no sign-out in between.
   * Nobody has refreshed the old row since, which is what makes it safe.
   */
  it("lets an abandoned token be taken over", async () => {
    const now = new Date("2026-09-03T12:00:00Z");
    await registerPushDevice(db, alice.id, TOKEN, "ios", now);
    await db
      .update(schema.pushDevices)
      .set({ updatedAt: daysAgo(PUSH_TOKEN_CLAIM_DAYS + 1, now) })
      .where(eq(schema.pushDevices.token, TOKEN));

    await expect(registerPushDevice(db, bob.id, TOKEN, "android", now)).resolves.toBe(
      "registered",
    );
    const rows = await db.select().from(schema.pushDevices);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: bob.id, platform: "android" });
  });

  it("holds the line right up to the window's edge", async () => {
    const now = new Date("2026-09-03T12:00:00Z");
    await registerPushDevice(db, alice.id, TOKEN, "ios", now);
    await db
      .update(schema.pushDevices)
      .set({ updatedAt: daysAgo(PUSH_TOKEN_CLAIM_DAYS - 1, now) })
      .where(eq(schema.pushDevices.token, TOKEN));

    expect(await registerPushDevice(db, bob.id, TOKEN, "ios", now)).toBe("claimed_by_another");
  });

  /**
   * The other half of the rule: signing out releases the token, so the next
   * person gets it immediately rather than waiting out the window.
   */
  it("frees the token the moment its owner releases it", async () => {
    await registerPushDevice(db, alice.id, TOKEN, "ios");
    await db.delete(schema.pushDevices).where(eq(schema.pushDevices.userId, alice.id));

    await expect(registerPushDevice(db, bob.id, TOKEN, "ios")).resolves.toBe("registered");
  });
});

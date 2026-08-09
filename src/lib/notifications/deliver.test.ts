import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestDevice, createTestUser, setupTestDb } from "@/test/helpers";
import { listRecentDeliveries, sendNotification } from "./deliver";
import { setPushSenderForTests, type PushSender, type SendResult } from "./sender";
import { saveAccountPreferences } from "./settings";

const NOW = new Date("2026-08-09T23:00:00.000Z");

/** Records what it was asked to send and answers with a scripted result. */
function fakeSender(result: SendResult = { ok: true }): PushSender & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async send(device) {
      calls.push(device.id);
      return result;
    },
  };
}

describe("sendNotification", () => {
  let db: DB;
  let user: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db);
    // Both transports configured, so tests exercise routing rather than config.
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "public");
    vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", "private");
    vi.stubEnv("FCM_PROJECT_ID", "project");
    vi.stubEnv("FCM_CLIENT_EMAIL", "sa@example.com");
    vi.stubEnv("FCM_PRIVATE_KEY", "key");
  });

  afterEach(() => {
    setPushSenderForTests(null);
    vi.unstubAllEnvs();
  });

  const message = { category: "price_alert", title: "Price drop", body: "Down to $42" };

  it("delivers to every eligible device and logs each one", async () => {
    const sender = fakeSender();
    setPushSenderForTests(sender);
    const a = await createTestDevice(db, user.id, { label: "Laptop" });
    const b = await createTestDevice(db, user.id, { label: "Phone", platform: "ios" });

    const report = await sendNotification(db, user.id, message, { now: NOW });

    expect(report.delivered).toBe(2);
    expect(sender.calls.sort()).toEqual([a.id, b.id].sort());

    const log = await listRecentDeliveries(db, user.id);
    expect(log).toHaveLength(2);
    expect(log.every((row) => row.status === "delivered")).toBe(true);
    // The label is snapshotted so the log survives the device being removed.
    expect(log.map((row) => row.deviceLabel).sort()).toEqual(["Laptop", "Phone"]);
  });

  it("records a suppression as loudly as a failure", async () => {
    // Otherwise a quiet-hours hold is indistinguishable from a broken pipeline.
    const sender = fakeSender();
    setPushSenderForTests(sender);
    const device = await createTestDevice(db, user.id);
    await saveAccountPreferences(db, user.id, {
      quietHoursEnabled: true,
      quietStart: "22:00",
      quietEnd: "08:00",
      timeZone: "UTC",
    });

    const report = await sendNotification(db, user.id, message, { now: NOW });

    expect(report.delivered).toBe(0);
    expect(report.suppressed).toBe(1);
    expect(sender.calls).toEqual([]);

    const [row] = await listRecentDeliveries(db, user.id);
    expect(row.status).toBe("suppressed_quiet_hours");
    expect(row.detail).toContain("10 PM – 8 AM");
    expect(row.deviceId).toBe(device.id);
  });

  it("honours each device's own quiet window at the same instant", async () => {
    const sender = fakeSender();
    setPushSenderForTests(sender);
    // 23:00 UTC is 17:00 in Denver (awake) and 00:00 in Lisbon (asleep).
    const desktop = await createTestDevice(db, user.id, {
      label: "Desktop",
      quietHoursMode: "custom",
      quietStart: "22:00",
      quietEnd: "08:00",
      timeZone: "America/Denver",
    });
    await createTestDevice(db, user.id, {
      label: "Phone",
      platform: "ios",
      quietHoursMode: "custom",
      quietStart: "22:00",
      quietEnd: "08:00",
      timeZone: "Europe/Lisbon",
    });

    const report = await sendNotification(db, user.id, message, { now: NOW });

    expect(sender.calls).toEqual([desktop.id]);
    expect(report.delivered).toBe(1);
    expect(report.suppressed).toBe(1);
  });

  it("clears the failure count on a success", async () => {
    setPushSenderForTests(fakeSender({ ok: true }));
    const device = await createTestDevice(db, user.id, {
      consecutiveFailures: 2,
      lastFailureReason: "Earlier trouble",
    });

    await sendNotification(db, user.id, message, { now: NOW });

    const [row] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, device.id));
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastFailureReason).toBeNull();
    expect(row.lastSuccessAt).toEqual(NOW);
  });

  it("counts a transient failure without retiring the device", async () => {
    setPushSenderForTests(fakeSender({ ok: false, error: "Push service unavailable" }));
    const device = await createTestDevice(db, user.id, { consecutiveFailures: 1 });

    const report = await sendNotification(db, user.id, message, { now: NOW });
    expect(report.failed).toBe(1);

    const [row] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, device.id));
    expect(row.consecutiveFailures).toBe(2);
    expect(row.revokedAt).toBeNull();
    expect(row.lastFailureReason).toBe("Push service unavailable");
  });

  it("retires a registration the push service says is gone", async () => {
    setPushSenderForTests(fakeSender({ ok: false, gone: true, error: "Subscription expired or was revoked" }));
    const device = await createTestDevice(db, user.id);

    await sendNotification(db, user.id, message, { now: NOW });

    const [row] = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, device.id));
    expect(row.revokedAt).toEqual(NOW);
    expect(row.lastFailureReason).toBe("Subscription expired or was revoked");
  });

  it("never calls the transport for a device that is already revoked", async () => {
    const sender = fakeSender();
    setPushSenderForTests(sender);
    await createTestDevice(db, user.id, { revokedAt: NOW, lastFailureReason: "Gone" });

    const report = await sendNotification(db, user.id, message, { now: NOW });

    expect(sender.calls).toEqual([]);
    expect(report.suppressed).toBe(1);
  });

  it("reports missing server credentials against the affected transport only", async () => {
    vi.stubEnv("FCM_PROJECT_ID", "");
    const sender = fakeSender();
    setPushSenderForTests(sender);
    const web = await createTestDevice(db, user.id, { label: "Laptop" });
    await createTestDevice(db, user.id, { label: "Phone", platform: "android" });

    const report = await sendNotification(db, user.id, message, { now: NOW });

    expect(report.failed).toBe(1);
    expect(sender.calls).toEqual([web.id]);
    const log = await listRecentDeliveries(db, user.id);
    const native = log.find((row) => row.deviceLabel === "Phone");
    expect(native?.status).toBe("not_configured");
    expect(native?.detail).toContain("FCM_PROJECT_ID");
  });

  it("targets a single device when asked", async () => {
    const sender = fakeSender();
    setPushSenderForTests(sender);
    const a = await createTestDevice(db, user.id);
    await createTestDevice(db, user.id);

    const report = await sendNotification(db, user.id, message, { now: NOW, deviceId: a.id });

    expect(sender.calls).toEqual([a.id]);
    expect(report.outcomes).toHaveLength(1);
  });

  it("logs the no-devices case instead of silently doing nothing", async () => {
    setPushSenderForTests(fakeSender());
    const report = await sendNotification(db, user.id, message, { now: NOW });

    expect(report).toMatchObject({ delivered: 0, failed: 0, outcomes: [] });
    const [row] = await listRecentDeliveries(db, user.id);
    expect(row.status).toBe("no_devices");
  });

  it("never touches another user's devices", async () => {
    const sender = fakeSender();
    setPushSenderForTests(sender);
    const other = await createTestUser(db);
    await createTestDevice(db, other.id);
    const mine = await createTestDevice(db, user.id);

    await sendNotification(db, user.id, message, { now: NOW });

    expect(sender.calls).toEqual([mine.id]);
  });
});

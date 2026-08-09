import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import {
  createTestDevice,
  createTestUser,
  jsonRequest,
  mockSessionModule,
  setSessionUser,
  setupTestDb,
} from "@/test/helpers";
import { setPushSenderForTests } from "@/lib/notifications/sender";
import type { NotificationSettingsView } from "@/lib/notifications/view";
import { GET, PATCH as PATCH_SETTINGS } from "./settings/route";
import { DELETE as DELETE_DEVICE, PATCH as PATCH_DEVICE } from "./devices/[id]/route";
import { POST as TEST_DEVICE } from "./devices/[id]/test/route";
import { DELETE as UNSUBSCRIBE, POST as SUBSCRIBE } from "./web/route";

vi.mock("@/lib/session", async () => mockSessionModule());

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("notification settings API", () => {
  let db: DB;
  let user: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db);
    setSessionUser(user);
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "public-key");
    vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", "private-key");
  });

  afterEach(() => {
    setPushSenderForTests(null);
    vi.unstubAllEnvs();
  });

  async function view(res: Response): Promise<NotificationSettingsView> {
    return (await res.json()) as NotificationSettingsView;
  }

  // -------------------------------------------------------------- GET

  it("returns defaults for a user who has never saved anything", async () => {
    const body = await view((await GET()) as Response);

    expect(body.account.quietHours.enabled).toBe(false);
    expect(body.account.categories.find((c) => c.id === "price_alert")).toMatchObject({
      enabled: true,
      source: "default",
    });
    expect(body.devices).toEqual([]);
    expect(body.health.headline).toMatch(/No devices/i);
    // Reading settings must not create a preferences row.
    expect(await db.select().from(schema.notificationPreferences)).toHaveLength(0);
  });

  it("requires a signed-in user", async () => {
    setSessionUser(null);
    expect(((await GET()) as Response).status).toBe(401);
  });

  it("exposes the VAPID public key only when one is configured", async () => {
    expect((await view((await GET()) as Response)).vapidPublicKey).toBe("public-key");
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "");
    expect((await view((await GET()) as Response)).vapidPublicKey).toBeNull();
  });

  // -------------------------------------------------- PATCH account

  it("saves account categories and quiet hours", async () => {
    const res = (await PATCH_SETTINGS(
      jsonRequest("/api/notifications/settings", "PATCH", {
        categories: { price_alert: false },
        quietHoursEnabled: true,
        quietStart: "23:00",
        quietEnd: "07:30",
        timeZone: "America/Denver",
      }),
    )) as Response;

    expect(res.status).toBe(200);
    const body = await view(res);
    expect(body.account.categories.find((c) => c.id === "price_alert")).toMatchObject({
      enabled: false,
      source: "account",
    });
    expect(body.account.quietHours).toMatchObject({
      enabled: true,
      start: "23:00",
      end: "07:30",
      timeZone: "America/Denver",
      description: "11 PM – 7:30 AM",
    });
  });

  it("merges category maps rather than replacing them", async () => {
    await PATCH_SETTINGS(
      jsonRequest("/api/notifications/settings", "PATCH", { categories: { price_alert: false } }),
    );
    const res = (await PATCH_SETTINGS(
      jsonRequest("/api/notifications/settings", "PATCH", { categories: { wrapped: false } }),
    )) as Response;

    const body = await view(res);
    expect(body.account.categories.find((c) => c.id === "price_alert")?.enabled).toBe(false);
    expect(body.account.categories.find((c) => c.id === "wrapped")?.enabled).toBe(false);
  });

  it("rejects a malformed quiet window", async () => {
    const res = (await PATCH_SETTINGS(
      jsonRequest("/api/notifications/settings", "PATCH", { quietStart: "9:00" }),
    )) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).details.join()).toMatch(/quietStart/);
  });

  it("rejects an unknown time zone", async () => {
    const res = (await PATCH_SETTINGS(
      jsonRequest("/api/notifications/settings", "PATCH", { timeZone: "Mars/Olympus_Mons" }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  it("rejects unknown categories", async () => {
    const res = (await PATCH_SETTINGS(
      jsonRequest("/api/notifications/settings", "PATCH", { categories: { drink_more: true } }),
    )) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).details.join()).toMatch(/drink_more/);
  });

  it("refuses to switch a critical category off account-wide", async () => {
    // A new-sign-in alert nobody sees is a security hole, not a preference.
    const res = (await PATCH_SETTINGS(
      jsonRequest("/api/notifications/settings", "PATCH", { categories: { account: false } }),
    )) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).details.join()).toMatch(/account/);
  });

  it("rejects a body that isn't JSON", async () => {
    const res = (await PATCH_SETTINGS(
      new Request("http://localhost/api/notifications/settings", { method: "PATCH", body: "not json" }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  // --------------------------------------------------- PATCH device

  it("gives a device its own quiet window", async () => {
    const device = await createTestDevice(db, user.id);
    const res = (await PATCH_DEVICE(
      jsonRequest(`/api/notifications/devices/${device.id}`, "PATCH", {
        quietHoursMode: "custom",
        quietStart: "21:00",
        quietEnd: "06:00",
        timeZone: "Europe/Lisbon",
      }),
      params(device.id),
    )) as Response;

    expect(res.status).toBe(200);
    const body = await view(res);
    expect(body.devices[0].quietHours).toMatchObject({
      mode: "custom",
      start: "21:00",
      end: "06:00",
      timeZone: "Europe/Lisbon",
    });
    expect(body.devices[0].quietHours.effective.source).toBe("device");
  });

  it("requires both ends of a custom window", async () => {
    // Half a window silently resolves to the account's — the exact confusion
    // per-device settings exist to remove.
    const device = await createTestDevice(db, user.id);
    const res = (await PATCH_DEVICE(
      jsonRequest(`/api/notifications/devices/${device.id}`, "PATCH", {
        quietHoursMode: "custom",
        quietStart: "21:00",
      }),
      params(device.id),
    )) as Response;
    expect(res.status).toBe(400);
  });

  it("renames, mutes, and overrides categories on one device", async () => {
    const device = await createTestDevice(db, user.id, { label: null });
    await PATCH_DEVICE(
      jsonRequest(`/api/notifications/devices/${device.id}`, "PATCH", { label: "Nightstand phone" }),
      params(device.id),
    );
    await PATCH_DEVICE(
      jsonRequest(`/api/notifications/devices/${device.id}`, "PATCH", { enabled: false }),
      params(device.id),
    );
    const res = (await PATCH_DEVICE(
      jsonRequest(`/api/notifications/devices/${device.id}`, "PATCH", {
        categoryOverrides: { price_alert: false },
      }),
      params(device.id),
    )) as Response;

    const body = await view(res);
    expect(body.devices[0]).toMatchObject({ name: "Nightstand phone", enabled: false });
    expect(body.devices[0].categories.find((c) => c.id === "price_alert")).toMatchObject({
      enabled: false,
      source: "device",
    });
  });

  it("clears a single override back to following the account", async () => {
    const device = await createTestDevice(db, user.id, { categoryOverrides: { price_alert: false, wrapped: false } });
    const res = (await PATCH_DEVICE(
      jsonRequest(`/api/notifications/devices/${device.id}`, "PATCH", {
        categoryOverrides: { price_alert: null },
      }),
      params(device.id),
    )) as Response;

    const body = await view(res);
    const categories = body.devices[0].categories;
    expect(categories.find((c) => c.id === "price_alert")?.source).toBe("default");
    // The other override survives.
    expect(categories.find((c) => c.id === "wrapped")).toMatchObject({ enabled: false, source: "device" });
  });

  it("404s for a device belonging to someone else", async () => {
    const other = await createTestUser(db);
    const theirs = await createTestDevice(db, other.id);

    const patched = (await PATCH_DEVICE(
      jsonRequest(`/api/notifications/devices/${theirs.id}`, "PATCH", { enabled: false }),
      params(theirs.id),
    )) as Response;
    expect(patched.status).toBe(404);

    const deleted = (await DELETE_DEVICE(
      new Request(`http://localhost/api/notifications/devices/${theirs.id}`, { method: "DELETE" }),
      params(theirs.id),
    )) as Response;
    expect(deleted.status).toBe(404);

    // And it is still there.
    expect(await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.id, theirs.id))).toHaveLength(1);
  });

  it("removes a device and returns the refreshed view", async () => {
    const device = await createTestDevice(db, user.id);
    const res = (await DELETE_DEVICE(
      new Request(`http://localhost/api/notifications/devices/${device.id}`, { method: "DELETE" }),
      params(device.id),
    )) as Response;

    expect(res.status).toBe(200);
    expect((await view(res)).devices).toEqual([]);
  });

  // ----------------------------------------------------------- test

  it("reports a successful test and marks the device verified", async () => {
    setPushSenderForTests({ send: async () => ({ ok: true }) });
    const device = await createTestDevice(db, user.id, { lastSuccessAt: null });

    const res = (await TEST_DEVICE(
      new Request("http://localhost/test", { method: "POST" }),
      params(device.id),
    )) as Response;
    const body = (await res.json()) as { outcome: { status: string }; settings: NotificationSettingsView };

    expect(body.outcome.status).toBe("delivered");
    expect(body.settings.devices[0].health.status).toBe("healthy");
    expect(body.settings.deliveries[0]).toMatchObject({ status: "delivered", categoryLabel: "Test notification" });
  });

  it("reports a failing test with the provider's reason, and turns the banner red", async () => {
    setPushSenderForTests({ send: async () => ({ ok: false, gone: true, error: "Subscription expired" }) });
    const device = await createTestDevice(db, user.id);

    const res = (await TEST_DEVICE(
      new Request("http://localhost/test", { method: "POST" }),
      params(device.id),
    )) as Response;
    const body = (await res.json()) as { outcome: { status: string; detail: string }; settings: NotificationSettingsView };

    expect(body.outcome).toMatchObject({ status: "failed", detail: "Subscription expired" });
    expect(body.settings.devices[0].health.status).toBe("revoked");
    expect(body.settings.health.severity).toBe("error");
    expect(body.settings.health.issues[0].deviceId).toBe(device.id);
  });

  it("tells the user a test was held rather than pretending it was sent", async () => {
    setPushSenderForTests({ send: async () => ({ ok: true }) });
    const device = await createTestDevice(db, user.id, {
      quietHoursMode: "custom",
      quietStart: "00:00",
      quietEnd: "23:59",
      timeZone: "UTC",
    });

    const res = (await TEST_DEVICE(
      new Request("http://localhost/test", { method: "POST" }),
      params(device.id),
    )) as Response;
    const body = (await res.json()) as { outcome: { status: string } };
    expect(body.outcome.status).toBe("suppressed_quiet_hours");
  });

  it("404s when testing a device that isn't yours", async () => {
    const other = await createTestUser(db);
    const theirs = await createTestDevice(db, other.id);
    const res = (await TEST_DEVICE(
      new Request("http://localhost/test", { method: "POST" }),
      params(theirs.id),
    )) as Response;
    expect(res.status).toBe(404);
  });

  // ------------------------------------------------ web subscription

  const subscription = {
    endpoint: "https://push.example.com/sub/abc",
    keys: { p256dh: "p256dh-key", auth: "auth-secret" },
  };

  it("registers a browser subscription with its keys", async () => {
    const res = (await SUBSCRIBE(
      jsonRequest("/api/notifications/web", "POST", { ...subscription, timeZone: "America/Denver" }),
    )) as Response;

    expect(res.status).toBe(201);
    const [row] = await db.select().from(schema.pushDevices);
    expect(row).toMatchObject({
      platform: "web",
      token: subscription.endpoint,
      p256dh: "p256dh-key",
      authSecret: "auth-secret",
      timeZone: "America/Denver",
    });
  });

  it("rejects a subscription without encryption keys", async () => {
    // A row that cannot receive is worse than no row: it looks healthy.
    const res = (await SUBSCRIBE(
      jsonRequest("/api/notifications/web", "POST", { endpoint: subscription.endpoint }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  it("re-subscribing revives a revoked registration instead of duplicating it", async () => {
    await SUBSCRIBE(jsonRequest("/api/notifications/web", "POST", subscription));
    await db
      .update(schema.pushDevices)
      .set({ revokedAt: new Date(), consecutiveFailures: 4, lastFailureReason: "Gone" })
      .where(eq(schema.pushDevices.token, subscription.endpoint));

    await SUBSCRIBE(jsonRequest("/api/notifications/web", "POST", subscription));

    const rows = await db.select().from(schema.pushDevices);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revokedAt: null, consecutiveFailures: 0, lastFailureReason: null });
  });

  it("unsubscribes by endpoint", async () => {
    await SUBSCRIBE(jsonRequest("/api/notifications/web", "POST", subscription));
    const res = (await UNSUBSCRIBE(
      new Request(
        `http://localhost/api/notifications/web?endpoint=${encodeURIComponent(subscription.endpoint)}`,
        { method: "DELETE" },
      ),
    )) as Response;

    expect(await res.json()).toEqual({ unregistered: true });
    expect(await db.select().from(schema.pushDevices)).toHaveLength(0);
  });

  it("requires an endpoint to unsubscribe", async () => {
    const res = (await UNSUBSCRIBE(
      new Request("http://localhost/api/notifications/web", { method: "DELETE" }),
    )) as Response;
    expect(res.status).toBe(400);
  });
});

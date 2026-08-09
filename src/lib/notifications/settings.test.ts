import { describe, expect, it } from "vitest";
import type { PushDevice } from "@/db/schema";
import {
  ACCOUNT_DEFAULTS,
  resolveCategory,
  resolveQuietHours,
  routeToDevice,
  validateQuietWindow,
  type AccountPreferences,
} from "./settings";

const utc = (hhmm: string) => new Date(`2026-08-09T${hhmm}:00.000Z`);

function device(overrides: Partial<PushDevice> = {}): PushDevice {
  return {
    id: "device-1",
    userId: "user-1",
    token: "token-1",
    platform: "web",
    p256dh: "key",
    authSecret: "auth",
    label: "Laptop",
    userAgent: null,
    enabled: true,
    categoryOverrides: null,
    quietHoursMode: "inherit",
    quietStart: null,
    quietEnd: null,
    timeZone: null,
    lastSeenAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
    revokedAt: null,
    createdAt: utc("00:00"),
    updatedAt: utc("00:00"),
    ...overrides,
  };
}

function account(overrides: Partial<AccountPreferences> = {}): AccountPreferences {
  return { ...ACCOUNT_DEFAULTS, ...overrides };
}

describe("resolveCategory", () => {
  it("falls back to the category's own default", () => {
    const resolved = resolveCategory(account(), null, "price_alert");
    expect(resolved).toEqual({ id: "price_alert", enabled: true, source: "default" });
    // catalog_verification ships off by default.
    expect(resolveCategory(account(), null, "catalog_verification").enabled).toBe(false);
  });

  it("prefers the account setting over the default", () => {
    const resolved = resolveCategory(account({ categories: { price_alert: false } }), null, "price_alert");
    expect(resolved).toEqual({ id: "price_alert", enabled: false, source: "account" });
  });

  it("prefers a device override over the account", () => {
    const resolved = resolveCategory(
      account({ categories: { price_alert: false } }),
      device({ categoryOverrides: { price_alert: true } }),
      "price_alert",
    );
    expect(resolved).toEqual({ id: "price_alert", enabled: true, source: "device" });
  });

  it("treats an absent override key as inheritance, not as false", () => {
    const resolved = resolveCategory(
      account(),
      device({ categoryOverrides: { wrapped: false } }),
      "price_alert",
    );
    expect(resolved.source).toBe("default");
    expect(resolved.enabled).toBe(true);
  });
});

describe("resolveQuietHours", () => {
  const nightly = account({ quietHoursEnabled: true, quietStart: "22:00", quietEnd: "08:00", timeZone: "UTC" });

  it("inherits the account window by default", () => {
    const resolved = resolveQuietHours(nightly, device(), utc("23:00"));
    expect(resolved.source).toBe("account");
    expect(resolved.activeNow).toBe(true);
    expect(resolved.until?.toISOString()).toBe("2026-08-10T08:00:00.000Z");
  });

  it("lets a device opt out of an account-wide window", () => {
    const resolved = resolveQuietHours(nightly, device({ quietHoursMode: "off" }), utc("23:00"));
    expect(resolved.window).toBeNull();
    expect(resolved.activeNow).toBe(false);
    expect(resolved.source).toBe("device");
  });

  it("lets a device set its own window even when the account has none", () => {
    // The headline case: a phone that sleeps while the account default is off.
    const resolved = resolveQuietHours(
      account(),
      device({ quietHoursMode: "custom", quietStart: "21:00", quietEnd: "07:00", timeZone: "UTC" }),
      utc("22:00"),
    );
    expect(resolved.source).toBe("device");
    expect(resolved.activeNow).toBe(true);
    expect(resolved.description).toBe("9 PM – 7 AM");
  });

  it("reads each device's window in that device's own zone", () => {
    // Same instant, same 22:00–08:00 window, opposite answers.
    const desktop = device({
      id: "desktop",
      quietHoursMode: "custom",
      quietStart: "22:00",
      quietEnd: "08:00",
      timeZone: "America/Denver",
    });
    const phone = device({
      id: "phone",
      quietHoursMode: "custom",
      quietStart: "22:00",
      quietEnd: "08:00",
      timeZone: "Europe/Lisbon",
    });
    expect(resolveQuietHours(account(), desktop, utc("03:00")).activeNow).toBe(false);
    expect(resolveQuietHours(account(), phone, utc("03:00")).activeNow).toBe(true);
  });

  it("falls back to the account zone when a custom window has none", () => {
    const resolved = resolveQuietHours(
      account({ timeZone: "Europe/Lisbon" }),
      device({ quietHoursMode: "custom", quietStart: "22:00", quietEnd: "08:00", timeZone: null }),
      utc("03:00"),
    );
    expect(resolved.window?.timeZone).toBe("Europe/Lisbon");
    expect(resolved.activeNow).toBe(true);
  });

  it("ignores a custom mode with an incomplete window", () => {
    // Half a window would silently resolve to the account's; better to have none.
    const resolved = resolveQuietHours(nightly, device({ quietHoursMode: "custom", quietStart: "22:00" }), utc("23:00"));
    expect(resolved.source).toBe("account");
  });
});

describe("routeToDevice", () => {
  const nightly = account({ quietHoursEnabled: true, quietStart: "22:00", quietEnd: "08:00", timeZone: "UTC" });

  it("delivers when nothing stands in the way", () => {
    expect(routeToDevice(account(), device(), "price_alert", utc("12:00"))).toEqual({
      deliver: true,
      status: "delivered",
      detail: null,
    });
  });

  it("holds during quiet hours and says whose window it was", () => {
    const decision = routeToDevice(nightly, device(), "price_alert", utc("23:00"));
    expect(decision.deliver).toBe(false);
    expect(decision.status).toBe("suppressed_quiet_hours");
    expect(decision.detail).toContain("10 PM – 8 AM");

    const own = routeToDevice(
      account(),
      device({ quietHoursMode: "custom", quietStart: "22:00", quietEnd: "08:00", timeZone: "UTC" }),
      "price_alert",
      utc("23:00"),
    );
    expect(own.detail).toContain("set on this device");
  });

  it("lets critical categories through quiet hours", () => {
    // A new-sign-in alert held until 08:00 is a security hole, not a courtesy.
    expect(routeToDevice(nightly, device(), "account", utc("23:00")).deliver).toBe(true);
  });

  it("does not exempt a test send from quiet hours", () => {
    // A test that ignored the setting would prove the wrong thing.
    expect(routeToDevice(nightly, device(), "test", utc("23:00")).status).toBe(
      "suppressed_quiet_hours",
    );
  });

  it("still sends a test for a category the user has switched off", () => {
    const decision = routeToDevice(
      account({ categories: { price_alert: false } }),
      device(),
      "test",
      utc("12:00"),
    );
    expect(decision.deliver).toBe(true);
  });

  it("reports which layer switched a category off", () => {
    expect(
      routeToDevice(account({ categories: { price_alert: false } }), device(), "price_alert", utc("12:00")).detail,
    ).toBe("Turned off for your account");
    expect(
      routeToDevice(account(), device({ categoryOverrides: { price_alert: false } }), "price_alert", utc("12:00"))
        .detail,
    ).toBe("Turned off for this device");
  });

  it("skips a muted device before anything else", () => {
    const decision = routeToDevice(account(), device({ enabled: false }), "account", utc("12:00"));
    expect(decision).toMatchObject({ deliver: false, status: "suppressed_device", detail: "Device is muted" });
  });

  it("skips a revoked registration and surfaces the provider's reason", () => {
    const decision = routeToDevice(
      account(),
      device({ revokedAt: utc("01:00"), lastFailureReason: "Subscription expired or was revoked" }),
      "account",
      utc("12:00"),
    );
    expect(decision.status).toBe("suppressed_device");
    expect(decision.detail).toBe("Subscription expired or was revoked");
  });
});

describe("validateQuietWindow", () => {
  it("accepts a well-formed window", () => {
    expect(validateQuietWindow({ start: "22:00", end: "08:00", timeZone: "UTC" })).toBeNull();
  });

  it("rejects bad times and zones", () => {
    expect(validateQuietWindow({ start: "9:00" })).toMatch(/start/);
    expect(validateQuietWindow({ end: "24:00" })).toMatch(/end/);
    expect(validateQuietWindow({ timeZone: "Mars/Olympus_Mons" })).toMatch(/timeZone/);
  });
});

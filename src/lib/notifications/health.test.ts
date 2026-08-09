import { describe, expect, it } from "vitest";
import type { PushDevice } from "@/db/schema";
import type { PushConfigStatus } from "./config";
import { accountHealth, describeUserAgent, deviceHealth, deviceName } from "./health";
import { ACCOUNT_DEFAULTS, type AccountPreferences } from "./settings";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const CONFIGURED: PushConfigStatus = {
  web: { configured: true, missing: [] },
  native: { configured: true, missing: [] },
};

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
    lastSeenAt: NOW,
    lastSuccessAt: NOW,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const account = (overrides: Partial<AccountPreferences> = {}): AccountPreferences => ({
  ...ACCOUNT_DEFAULTS,
  ...overrides,
});

describe("deviceHealth", () => {
  it("reports a working device", () => {
    const health = deviceHealth(device(), account(), CONFIGURED, NOW);
    expect(health).toMatchObject({ status: "healthy", severity: "ok" });
  });

  it("leads with missing server credentials, ahead of anything device-side", () => {
    // Nothing the user does to their phone fixes an unset VAPID key.
    const health = deviceHealth(device({ enabled: false }), account(), {
      ...CONFIGURED,
      web: { configured: false, missing: ["WEB_PUSH_VAPID_PRIVATE_KEY"] },
    }, NOW);
    expect(health.status).toBe("not_configured");
    expect(health.severity).toBe("error");
    expect(health.fix).toContain("WEB_PUSH_VAPID_PRIVATE_KEY");
  });

  it("only blames the transport the device actually uses", () => {
    const health = deviceHealth(device({ platform: "ios" }), account(), {
      web: { configured: false, missing: ["NEXT_PUBLIC_VAPID_PUBLIC_KEY"] },
      native: { configured: true, missing: [] },
    }, NOW);
    expect(health.status).not.toBe("not_configured");
  });

  it("flags a revoked registration as an error with a concrete fix", () => {
    const health = deviceHealth(
      device({ revokedAt: NOW, lastFailureReason: "Subscription expired or was revoked" }),
      account(),
      CONFIGURED,
      NOW,
    );
    expect(health).toMatchObject({ status: "revoked", severity: "error" });
    expect(health.detail).toContain("Subscription expired");
    expect(health.fix).toBeTruthy();
  });

  it("escalates repeated failures but treats a single one as a warning", () => {
    expect(deviceHealth(device({ consecutiveFailures: 3 }), account(), CONFIGURED, NOW)).toMatchObject({
      status: "failing",
      severity: "error",
    });
    expect(deviceHealth(device({ consecutiveFailures: 1 }), account(), CONFIGURED, NOW)).toMatchObject({
      status: "failing",
      severity: "warn",
    });
  });

  it("calls out a device where every type is off", () => {
    // Easy to reach one toggle at a time, and invisible afterwards.
    const overrides = Object.fromEntries(
      ["price_alert", "tasting_invite", "catalog_verification", "wrapped", "account"].map((id) => [id, false]),
    );
    const health = deviceHealth(device({ categoryOverrides: overrides }), account(), CONFIGURED, NOW);
    expect(health).toMatchObject({ status: "silenced", severity: "warn" });
  });

  it("shows quiet hours as a healthy state, not a fault", () => {
    const health = deviceHealth(
      device({ quietHoursMode: "custom", quietStart: "08:00", quietEnd: "18:00", timeZone: "UTC" }),
      account(),
      CONFIGURED,
      NOW,
    );
    expect(health).toMatchObject({ status: "quiet", severity: "ok" });
    expect(health.detail).toContain("this device");
  });

  it("marks a never-delivered device as unverified rather than healthy", () => {
    const health = deviceHealth(device({ lastSuccessAt: null }), account(), CONFIGURED, NOW);
    expect(health).toMatchObject({ status: "untested", severity: "info" });
  });

  it("marks a long-silent device stale", () => {
    const old = new Date("2026-01-01T00:00:00.000Z");
    const health = deviceHealth(
      device({ lastSuccessAt: old, lastSeenAt: old, createdAt: old }),
      account(),
      CONFIGURED,
      NOW,
    );
    expect(health).toMatchObject({ status: "stale", severity: "warn" });
  });

  it("reports a muted device as information, not a problem", () => {
    expect(deviceHealth(device({ enabled: false }), account(), CONFIGURED, NOW)).toMatchObject({
      status: "muted",
      severity: "info",
    });
  });
});

describe("accountHealth", () => {
  it("asks for a device when there are none", () => {
    const health = accountHealth([], account(), CONFIGURED, NOW);
    expect(health.severity).toBe("warn");
    expect(health.headline).toMatch(/No devices/i);
  });

  it("summarises a healthy account", () => {
    const health = accountHealth([device(), device({ id: "d2" })], account(), CONFIGURED, NOW);
    expect(health.severity).toBe("ok");
    expect(health.detail).toBe("2 of 2 devices are set to receive them.");
    expect(health.issues).toHaveLength(0);
  });

  it("counts broken devices and lists each with its fix", () => {
    const health = accountHealth(
      [device(), device({ id: "d2", revokedAt: NOW }), device({ id: "d3", consecutiveFailures: 5 })],
      account(),
      CONFIGURED,
      NOW,
    );
    expect(health.severity).toBe("error");
    expect(health.headline).toBe("2 devices aren't receiving notifications");
    expect(health.issues).toHaveLength(2);
    expect(health.issues.every((i) => i.fix)).toBe(true);
    expect(health.issues[0].deviceId).toBeTruthy();
  });

  it("uses the singular for one broken device", () => {
    const health = accountHealth([device({ revokedAt: NOW })], account(), CONFIGURED, NOW);
    expect(health.headline).toBe("One device isn't receiving notifications");
  });

  it("warns without erroring when settings alone would silence a device", () => {
    const health = accountHealth([device({ enabled: true, categoryOverrides: {
      price_alert: false, tasting_invite: false, catalog_verification: false, wrapped: false, account: false,
    } })], account(), CONFIGURED, NOW);
    expect(health.severity).toBe("warn");
    expect(health.issues).toHaveLength(1);
  });

  it("reports an account-wide silence above the device list", () => {
    const silent = account({
      categories: { price_alert: false, tasting_invite: false, wrapped: false, account: false },
    });
    const health = accountHealth([device()], silent, CONFIGURED, NOW);
    expect(health.issues[0].label).toMatch(/Every notification type is off/);
    expect(health.issues[0].deviceId).toBeUndefined();
  });
});

describe("deviceName", () => {
  it("prefers the user's own label", () => {
    expect(deviceName({ label: "Nightstand phone", platform: "ios", userAgent: null })).toBe("Nightstand phone");
  });

  it("falls back to the user agent, then the platform", () => {
    expect(
      deviceName({
        label: null,
        platform: "web",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      }),
    ).toBe("Chrome on macOS");
    expect(deviceName({ label: "   ", platform: "ios", userAgent: null })).toBe("iPhone");
    expect(deviceName({ label: null, platform: "android", userAgent: null })).toBe("Android phone");
  });
});

describe("describeUserAgent", () => {
  it("names browser and OS without version soup", () => {
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) Firefox/121.0")).toBe("Firefox on Windows");
    // Edge and Opera both claim to be Chrome; check them first.
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36 Edg/120")).toBe(
      "Edge on Windows",
    );
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1")).toBe("Safari on iOS");
  });

  it("returns null when it cannot tell", () => {
    expect(describeUserAgent(null)).toBeNull();
    expect(describeUserAgent("curl/8.0")).toBeNull();
  });
});

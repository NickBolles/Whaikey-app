// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review SEC-M6, second half. The server keeps a push token with the account
 * that registered it until that account releases it or stops refreshing it —
 * and nothing was refreshing it, so every row aged into "abandoned" after a
 * week and became claimable by anyone holding the leaked token. These pin the
 * two doors: the refresh, and the release on sign-out.
 */
const permissions = { receive: "granted" as string };
const listeners: Record<string, (payload: { value: string }) => void> = {};

const checkPermissions = vi.fn(async () => permissions);
const requestPermissions = vi.fn(async () => permissions);
const register = vi.fn(async () => {
  listeners.registration?.({ value: "tok-refreshed" });
});
const removeAllListeners = vi.fn(async () => {});

vi.mock("./platform", () => ({
  loadPlugin: vi.fn(async (load: () => Promise<unknown>) => load()),
  platform: () => "ios",
}));

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    checkPermissions: () => checkPermissions(),
    requestPermissions: () => requestPermissions(),
    register: () => register(),
    removeAllListeners: () => removeAllListeners(),
    addListener: (event: string, handler: (payload: { value: string }) => void) => {
      listeners[event] = handler;
      return Promise.resolve({ remove: () => {} });
    },
  },
}));

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  permissions.receive = "granted";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ registered: true });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("refreshPushRegistration", () => {
  it("re-registers a device that already opted in", async () => {
    const { refreshPushRegistration } = await import("./push");
    await refreshPushRegistration();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "/api/native/push-token",
      method: "POST",
      body: { token: "tok-refreshed", platform: "ios" },
    });
  });

  /**
   * iOS gives you exactly one chance to ask for permission, and a launch is
   * not the moment to spend it. A device that has not opted in is left alone.
   */
  it("never prompts, and does nothing when permission was not granted", async () => {
    for (const state of ["prompt", "denied"]) {
      permissions.receive = state;
      const { refreshPushRegistration } = await import("./push");
      await refreshPushRegistration();
    }
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("disablePush", () => {
  /**
   * The tokenless DELETE means "every device on this account". Signing out on
   * one phone must not kill notifications on the owner's others — or free
   * those tokens for somebody else to claim.
   */
  it("releases this device only", async () => {
    const { refreshPushRegistration, disablePush } = await import("./push");
    await refreshPushRegistration();
    calls.length = 0;

    await expect(disablePush()).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain("token=tok-refreshed");
  });

  /**
   * A cleared or unavailable local cache is not the same fact as "this device
   * never registered". Treating it as one reports a release that never
   * happened and leaves the row live on a shared device, so the token is
   * recovered from the OS instead.
   */
  it("recovers the token from the OS when the cache is gone", async () => {
    window.localStorage.clear();
    const { disablePush } = await import("./push");
    await expect(disablePush()).resolves.toBe(true);

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain("token=tok-refreshed");
  });

  it("does nothing, and says so honestly, when push was never granted", async () => {
    window.localStorage.clear();
    permissions.receive = "prompt";
    const { disablePush } = await import("./push");
    await expect(disablePush()).resolves.toBe(true);
    // Not a tokenless DELETE: there is nothing of ours to release, and asking
    // for one would take the account's other devices with it.
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("reports a release the server did not confirm", async () => {
    const { refreshPushRegistration, disablePush } = await import("./push");
    await refreshPushRegistration();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(disablePush()).resolves.toBe(false);
  });
});

describe("signOutCompletely", () => {
  it("releases the token before ending the session", async () => {
    const { refreshPushRegistration } = await import("./push");
    await refreshPushRegistration();

    const order: string[] = [];
    vi.doMock("@/lib/auth-client", () => ({
      signOut: vi.fn(async () => {
        order.push("signOut");
      }),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        order.push(`${init?.method ?? "GET"} ${url}`);
        return Response.json({ unregistered: true });
      }),
    );

    const { signOutCompletely } = await import("@/lib/sign-out");
    await signOutCompletely();

    // Order matters: the DELETE needs the session it is about to end.
    expect(order).toEqual([
      "DELETE /api/native/push-token?token=tok-refreshed",
      "signOut",
    ]);
    vi.doUnmock("@/lib/auth-client");
  });

  it("still signs out when the token cannot be released", async () => {
    const signOut = vi.fn(async () => {});
    vi.doMock("@/lib/auth-client", () => ({ signOut }));
    vi.resetModules();

    const { refreshPushRegistration } = await import("./push");
    await refreshPushRegistration();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const { signOutCompletely } = await import("@/lib/sign-out");
    // Reported rather than swallowed — and it still signs out.
    await expect(signOutCompletely()).resolves.toEqual({ pushReleased: false });
    // Nobody is trapped in an account because push cleanup failed — and a
    // device that can't reach the server can't be notified by it either.
    expect(signOut).toHaveBeenCalled();
    vi.doUnmock("@/lib/auth-client");
  });
});

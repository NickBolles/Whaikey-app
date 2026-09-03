// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const router = { back: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

/**
 * Capture the shell's deep-link handler so a callback can be delivered the way
 * the OS would — including one the app never asked for.
 */
let deliverDeepLink: (path: string, rawUrl: string) => void = () => {};
vi.mock("@/lib/native/app-lifecycle", async (importOriginal) => ({
  // deepLinkPath is pure URL parsing that parseAuthCallback depends on; only
  // the listeners need to be stand-ins.
  ...(await importOriginal<typeof import("@/lib/native/app-lifecycle")>()),
  onDeepLink: (handler: (path: string, rawUrl: string) => void) => {
    deliverDeepLink = handler;
    return () => {};
  },
  onBackButton: () => () => {},
  onResume: () => () => {},
  exitApp: vi.fn(),
}));
vi.mock("@/lib/native/app-chrome", () => ({
  applyStatusBarStyle: vi.fn(),
  configureKeyboard: vi.fn(),
  hideSplash: vi.fn(),
}));

// These tests pose as a device, so the real plugins would be reached. Preferences
// is where the in-flight state and verifier live; back it with localStorage so
// the store behaves like the device's and the test can seed it.
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: localStorage.getItem(key) }),
    set: async ({ key, value }: { key: string; value: string }) => {
      localStorage.setItem(key, value);
    },
    remove: async ({ key }: { key: string }) => localStorage.removeItem(key),
  },
}));
vi.mock("@capacitor/browser", () => ({
  Browser: { open: vi.fn(async () => {}), close: vi.fn(async () => {}) },
}));

import { NativeShell } from "@/components/native-shell";

const PENDING_KEY = "whaikey.native-auth.pending.v1";
const STATE = "the-nonce-this-app-minted";
const VERIFIER = "the-verifier-this-app-kept";

const assign = vi.fn();

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // The shell only wires deep links on a device.
  Object.defineProperty(window, "Capacitor", {
    value: { getPlatform: () => "ios", isNativePlatform: () => true },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign, origin: "https://app.whaikey.com" },
    configurable: true,
    writable: true,
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 201 })));
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "Capacitor");
  document.documentElement.classList.remove("native-app");
  vi.unstubAllGlobals();
});

function startedSignIn() {
  localStorage.setItem(PENDING_KEY, JSON.stringify({ state: STATE, verifier: VERIFIER }));
}

/**
 * `whaikey://` is a custom scheme: on Android any app may register it, on iOS
 * the last installer wins. So an inbound auth callback is a claim by an unknown
 * sender, and the shell used to act on every one of them — redeeming whatever
 * code arrived, with no interaction, which silently moved the user's WebView
 * into the sender's account (review SEC-H1).
 */
describe("NativeShell auth callback", () => {
  it("redeems a callback that matches the sign-in this app started", async () => {
    startedSignIn();
    render(<NativeShell />);

    deliverDeepLink("/auth/callback", `whaikey://auth/callback?code=abc123&state=${STATE}`);

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        `/api/auth/native/exchange?code=abc123&code_verifier=${VERIFIER}`,
      ),
    );
  });

  it("ignores a code pushed at the app when no sign-in was started", async () => {
    render(<NativeShell />);

    deliverDeepLink("/auth/callback", "whaikey://auth/callback?code=attacker-code&state=whatever");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(assign).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("ignores a code whose state is not the one this app is waiting for", async () => {
    startedSignIn();
    render(<NativeShell />);

    deliverDeepLink(
      "/auth/callback",
      "whaikey://auth/callback?code=attacker-code&state=some-other-nonce",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(assign).not.toHaveBeenCalled();
  });

  it("ignores a code that carries no state at all", async () => {
    // What an attacker who has never seen our nonce can actually produce.
    startedSignIn();
    render(<NativeShell />);

    deliverDeepLink("/auth/callback", "whaikey://auth/callback?code=attacker-code");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(assign).not.toHaveBeenCalled();
  });

  /**
   * The mismatch has to be free for the user: if a forged callback consumed the
   * pending sign-in, any app or website able to launch `whaikey://` could
   * cancel a real sign-in on demand.
   */
  it("leaves the pending sign-in intact when a forged callback is dropped", async () => {
    startedSignIn();
    render(<NativeShell />);

    deliverDeepLink("/auth/callback", "whaikey://auth/callback?code=attacker&state=wrong-nonce");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(assign).not.toHaveBeenCalled();

    // The real callback still works.
    deliverDeepLink("/auth/callback", `whaikey://auth/callback?code=abc123&state=${STATE}`);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        `/api/auth/native/exchange?code=abc123&code_verifier=${VERIFIER}`,
      ),
    );
  });

  it("accepts one callback per sign-in, so a replayed link is inert", async () => {
    startedSignIn();
    render(<NativeShell />);
    const link = `whaikey://auth/callback?code=abc123&state=${STATE}`;

    deliverDeepLink("/auth/callback", link);
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));

    deliverDeepLink("/auth/callback", link);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("shows a matched failure at sign-in, with the return target kept", async () => {
    startedSignIn();
    render(<NativeShell />);

    deliverDeepLink(
      "/auth/callback",
      `whaikey://auth/callback?error=not_signed_in&state=${STATE}&next=%2Fadd%2Fsasha`,
    );

    await waitFor(() => expect(router.push).toHaveBeenCalled());
    const pushed = router.push.mock.calls[0][0] as string;
    expect(pushed).toContain("/sign-in?");
    expect(pushed).toContain("next=%2Fadd%2Fsasha");
  });

  it("still routes ordinary deep links", async () => {
    render(<NativeShell />);
    deliverDeepLink("/bottles/123", "whaikey://bottles/123");
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/bottles/123"));
  });
});

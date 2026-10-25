// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The device half of native Sign in with Apple: what is sent to Apple (the
 * hash of the server's nonce), what is posted back (the raw nonce), and every
 * way the path declines so the sign-in page can fall back to the browser.
 */
const authorize = vi.fn<(o: { nonce: string }) => Promise<Record<string, unknown>>>();
vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({ authorize }) }));

const NONCE = "lt2abc.server-minted-random-value.mac";

function setPlatform(name: "ios" | "android" | null, hasPlugin = true) {
  (window as { Capacitor?: unknown }).Capacitor = name
    ? {
        getPlatform: () => name,
        isNativePlatform: () => true,
        isPluginAvailable: (p: string) => hasPlugin && p === "WhaikeyAppleSignIn",
      }
    : undefined;
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

let mod: typeof import("./apple-sign-in");

beforeEach(async () => {
  vi.resetModules();
  authorize.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) =>
    url.includes("/nonce")
      ? new Response(JSON.stringify({ nonce: NONCE }), { status: 200 })
      : new Response(JSON.stringify({ redirect: false }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  mod = await import("./apple-sign-in");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setPlatform(null);
});

async function sha256Hex(v: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("signInWithAppleNative", () => {
  it("is unavailable on the web, on Android, and on a shell without the plugin", async () => {
    setPlatform(null);
    expect(await mod.signInWithAppleNative()).toEqual({ status: "unavailable" });
    setPlatform("android");
    expect(await mod.signInWithAppleNative()).toEqual({ status: "unavailable" });
    setPlatform("ios", false);
    expect(await mod.signInWithAppleNative()).toEqual({ status: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable when the server has no Apple bundle id configured", async () => {
    setPlatform("ios");
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    expect(await mod.signInWithAppleNative()).toEqual({ status: "unavailable" });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("hashes the nonce for Apple and posts the raw one back with the token", async () => {
    setPlatform("ios");
    authorize.mockResolvedValue({ identityToken: "id.token.jwt", givenName: "Ada", familyName: "L" });
    expect(await mod.signInWithAppleNative()).toEqual({ status: "signed-in" });
    expect(authorize).toHaveBeenCalledWith({ nonce: await sha256Hex(NONCE) });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/auth/sign-in/social");
    expect(JSON.parse(String(init?.body))).toEqual({
      provider: "apple",
      idToken: {
        token: "id.token.jwt",
        nonce: NONCE,
        user: { name: { firstName: "Ada", lastName: "L" } },
      },
    });
  });

  it("reads a dismissed sheet as cancelled, not as an error", async () => {
    setPlatform("ios");
    authorize.mockRejectedValue(Object.assign(new Error("canceled"), { code: "canceled" }));
    expect(await mod.signInWithAppleNative()).toEqual({ status: "cancelled" });
  });

  it("fails with a message when the server refuses the token", async () => {
    setPlatform("ios");
    authorize.mockResolvedValue({ identityToken: "id.token.jwt" });
    fetchMock.mockImplementation(async (url) =>
      url.includes("/nonce")
        ? new Response(JSON.stringify({ nonce: NONCE }), { status: 200 })
        : new Response("{}", { status: 401 }),
    );
    const result = await mod.signInWithAppleNative();
    expect(result.status).toBe("failed");
  });
});

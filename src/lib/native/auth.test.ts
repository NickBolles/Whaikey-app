// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The callback parser decides whether an inbound deep link is a sign-in
 * completion carrying an exchange code (docs/NATIVE_APP.md §2.3). Getting it
 * wrong either strands the user at sign-in or routes an auth code somewhere it
 * shouldn't go, so the negative cases matter as much as the happy path.
 */
const APP_URL = "https://app.whaikey.com";

let mod: typeof import("./auth");

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_URL);
  mod = await import("./auth");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseAuthCallback", () => {
  it("extracts the exchange code", () => {
    expect(mod.parseAuthCallback("whaikey://auth/callback?code=abc123")).toEqual({
      code: "abc123",
    });
  });

  it("extracts an error when sign-in did not complete", () => {
    expect(mod.parseAuthCallback("whaikey://auth/callback?error=not_signed_in")).toEqual({
      error: "not_signed_in",
    });
  });

  it("treats a callback with neither code nor error as an unknown failure", () => {
    // Better a clear message than a silent hang on the sign-in screen.
    expect(mod.parseAuthCallback("whaikey://auth/callback")).toEqual({ error: "unknown" });
  });

  it("ignores deep links that are not the auth callback", () => {
    // These are ordinary navigation and must fall through to the router.
    expect(mod.parseAuthCallback("whaikey://bottles/123")).toBeNull();
    expect(mod.parseAuthCallback(`${APP_URL}/bar`)).toBeNull();
  });

  it("ignores links from other hosts entirely", () => {
    expect(mod.parseAuthCallback("https://evil.example.com/auth/callback?code=abc")).toBeNull();
    expect(mod.parseAuthCallback("not a url")).toBeNull();
  });
});

describe("exchangeUrl", () => {
  it("encodes the code into the in-WebView exchange path", () => {
    expect(mod.exchangeUrl("abc123")).toBe("/api/auth/native/exchange?code=abc123");
  });

  it("escapes codes containing URL-significant characters", () => {
    // base64url shouldn't produce these, but a malformed callback must not be
    // able to inject extra query parameters into the exchange request.
    expect(mod.exchangeUrl("a&b=c")).toBe("/api/auth/native/exchange?code=a%26b%3Dc");
  });
});

describe("describeNativeAuthError", () => {
  it("turns server error codes into something a user can act on", () => {
    expect(mod.describeNativeAuthError("not_signed_in")).toBe("Sign-in was cancelled.");
    expect(mod.describeNativeAuthError("exchange_failed")).toContain("try again");
  });

  it("falls back to a generic message for unrecognised codes", () => {
    expect(mod.describeNativeAuthError("some_new_code")).toBe("Sign-in failed. Please try again.");
  });

  it("returns null when there is no error", () => {
    expect(mod.describeNativeAuthError(null)).toBeNull();
  });
});

describe("startNativeSignIn", () => {
  it("reports unavailable on the web so the caller uses the normal flow", async () => {
    // A browser has no embedded-WebView problem to work around.
    await expect(mod.startNativeSignIn("google")).resolves.toEqual({ status: "unavailable" });
  });
});

describe("return path threading", () => {
  it("parses a next param out of the auth callback", () => {
    expect(mod.parseAuthCallback("whaikey://auth/callback?code=abc&next=%2Fadd%2Fsasha")).toEqual({
      code: "abc",
      next: "/add/sasha",
    });
  });

  it("exchangeUrl carries next, encoded", () => {
    expect(mod.exchangeUrl("abc", "/add/sasha")).toBe(
      "/api/auth/native/exchange?code=abc&next=%2Fadd%2Fsasha",
    );
    expect(mod.exchangeUrl("abc")).toBe("/api/auth/native/exchange?code=abc");
  });
});

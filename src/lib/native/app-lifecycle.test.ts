// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `deepLinkPath` reads NEXT_PUBLIC_APP_URL at module load to build its allowlist,
 * so the env has to be in place before the import — hence the dynamic import and
 * `resetModules` per test.
 */
const APP_URL = "https://app.whaikey.com";

async function loadDeepLinkPath() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_URL);
  return (await import("./app-lifecycle")).deepLinkPath;
}

let deepLinkPath: Awaited<ReturnType<typeof loadDeepLinkPath>>;

beforeEach(async () => {
  deepLinkPath = await loadDeepLinkPath();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deepLinkPath — custom scheme", () => {
  it("maps whaikey://<path> onto an in-app path", () => {
    // URL() parses the first segment of a custom-scheme link as the host.
    expect(deepLinkPath("whaikey://bottles/123")).toBe("/bottles/123");
    expect(deepLinkPath("whaikey://bar")).toBe("/bar");
  });

  it("keeps the query string", () => {
    expect(deepLinkPath("whaikey://search?q=lagavulin")).toBe("/search?q=lagavulin");
  });

  it("normalises a bare scheme to the home route", () => {
    expect(deepLinkPath("whaikey://")).toBe("/");
  });

  it("strips a trailing slash so routes don't double up", () => {
    expect(deepLinkPath("whaikey://bar/")).toBe("/bar");
  });
});

describe("deepLinkPath — universal links", () => {
  it("accepts https links on the app's own host", () => {
    expect(deepLinkPath(`${APP_URL}/bottles/123`)).toBe("/bottles/123");
    expect(deepLinkPath(`${APP_URL}/search?q=rye`)).toBe("/search?q=rye");
  });

  it("refuses links to any other host", () => {
    // Navigating the app because some other site's link was opened would be a
    // redirect primitive handed to whoever wrote the link.
    expect(deepLinkPath("https://evil.example.com/bottles/123")).toBeNull();
    expect(deepLinkPath("https://app.whaikey.com.evil.example.com/bar")).toBeNull();
  });

  it("refuses other schemes and unparseable input", () => {
    expect(deepLinkPath("javascript:alert(1)")).toBeNull();
    expect(deepLinkPath("not a url")).toBeNull();
    expect(deepLinkPath("")).toBeNull();
  });
});

describe("listener registration on web", () => {
  it("returns a no-op unsubscribe rather than throwing", async () => {
    const { onBackButton, onDeepLink, onResume } = await import("./app-lifecycle");
    const handler = vi.fn();
    // No Capacitor global here, so nothing registers — cleanup must still be safe
    // to call unconditionally from a useEffect return.
    for (const unsubscribe of [onBackButton(handler), onDeepLink(handler), onResume(handler)]) {
      expect(() => unsubscribe()).not.toThrow();
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

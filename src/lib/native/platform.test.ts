// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAndroid, isIos, isNativeApp, loadPlugin, nativeOnly, platform } from "./platform";

/** Stand in for the global the Capacitor runtime injects into the WebView. */
function fakeCapacitor(name: "ios" | "android") {
  Object.defineProperty(window, "Capacitor", {
    value: { getPlatform: () => name, isNativePlatform: () => true },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "Capacitor");
  vi.restoreAllMocks();
});

describe("platform detection", () => {
  it("reports web when the Capacitor global is absent", () => {
    expect(platform()).toBe("web");
    expect(isNativeApp()).toBe(false);
    expect(isIos()).toBe(false);
    expect(isAndroid()).toBe(false);
  });

  it("reports the native platform the runtime injected", () => {
    fakeCapacitor("ios");
    expect(platform()).toBe("ios");
    expect(isNativeApp()).toBe(true);
    expect(isIos()).toBe(true);
    expect(isAndroid()).toBe(false);
  });

  it("treats an unrecognised platform name as web", () => {
    // Capacitor reports "web" for its own browser runtime; anything unexpected
    // must not be mistaken for a device.
    Object.defineProperty(window, "Capacitor", {
      value: { getPlatform: () => "electron" },
      configurable: true,
      writable: true,
    });
    expect(platform()).toBe("web");
    expect(isNativeApp()).toBe(false);
  });
});

describe("loadPlugin", () => {
  it("does not even attempt to load on web", async () => {
    const load = vi.fn();
    await expect(loadPlugin(load)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("returns the plugin on a device", async () => {
    fakeCapacitor("android");
    await expect(loadPlugin(async () => ({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it("returns null instead of throwing when a plugin is missing", async () => {
    fakeCapacitor("android");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      loadPlugin(() => Promise.reject(new Error("module not found"))),
    ).resolves.toBeNull();
  });
});

describe("nativeOnly", () => {
  it("skips the call on web", async () => {
    const fn = vi.fn();
    await nativeOnly(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("swallows failures so native chrome can never break a render", async () => {
    fakeCapacitor("ios");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(nativeOnly(() => Promise.reject(new Error("no status bar")))).resolves.toBeUndefined();
  });
});

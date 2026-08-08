// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCANNING_CLASS,
  isNativeScanningAvailable,
  isNativeTorchAvailable,
  isWebDetectorAvailable,
  requestCameraPermission,
  setNativeTorch,
  startNativeScan,
} from "./barcode";

afterEach(() => {
  Reflect.deleteProperty(window, "Capacitor");
  Reflect.deleteProperty(window, "BarcodeDetector");
  document.documentElement.classList.remove(SCANNING_CLASS);
  vi.restoreAllMocks();
});

function fakeNative() {
  Object.defineProperty(window, "Capacitor", {
    value: { getPlatform: () => "ios", isNativePlatform: () => true },
    configurable: true,
    writable: true,
  });
}

describe("web fallbacks", () => {
  it("reports the web detector only when the browser has one", () => {
    expect(isWebDetectorAvailable()).toBe(false);
    Object.defineProperty(window, "BarcodeDetector", { value: class {}, configurable: true });
    expect(isWebDetectorAvailable()).toBe(true);
  });

  it("hides the web detector inside the native shell so MLKit always wins", () => {
    // WKWebView has no BarcodeDetector at all, but a Chromium-backed Android
    // WebView does — and the native scanner is the better engine on both.
    Object.defineProperty(window, "BarcodeDetector", { value: class {}, configurable: true });
    fakeNative();
    expect(isWebDetectorAvailable()).toBe(false);
  });

  it("reports native scanning and torch as unavailable on web", async () => {
    await expect(isNativeScanningAvailable()).resolves.toBe(false);
    await expect(isNativeTorchAvailable()).resolves.toBe(false);
    await expect(setNativeTorch(true)).resolves.toBe(false);
  });

  it("leaves permission undecided on web rather than claiming a denial", async () => {
    await expect(requestCameraPermission()).resolves.toBe("prompt");
  });
});

describe("startNativeScan", () => {
  it("returns null on web so the caller uses its own camera path", async () => {
    await expect(startNativeScan({ onBarcode: vi.fn() })).resolves.toBeNull();
  });

  it("never leaves the page transparent when it declines to start", async () => {
    // A page stuck transparent shows the OS behind a dead scanner — the worst
    // possible failure mode, so assert the class is untouched.
    await startNativeScan({ onBarcode: vi.fn() });
    expect(document.documentElement.classList.contains(SCANNING_CLASS)).toBe(false);
  });

  it("returns null when the plugin is absent on a device", async () => {
    fakeNative();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("@capacitor-mlkit/barcode-scanning", () => {
      throw new Error("plugin not installed in this build");
    });
    await expect(startNativeScan({ onBarcode: vi.fn() })).resolves.toBeNull();
    expect(document.documentElement.classList.contains(SCANNING_CLASS)).toBe(false);
    vi.doUnmock("@capacitor-mlkit/barcode-scanning");
  });
});

/**
 * Barcode scanning (docs/NATIVE_APP.md §3.1).
 *
 * The web scanner in `src/app/scan/scan-client.tsx` polls the `BarcodeDetector`
 * Web API, which exists only in Chromium. **WKWebView has no `BarcodeDetector`**,
 * so barcode scanning is dead on every iPhone — on the web app and inside any
 * WebView. Routing the native shell through MLKit is what makes the core loop
 * work on iOS, and it is the strongest single argument for shipping natively at
 * all.
 *
 * Native scanning uses the plugin's `startScan` mode: the camera preview is
 * rendered by the OS *behind* the WebView, and the app's own overlay (viewfinder
 * frame, session queue, buttons) stays on top as normal DOM. That keeps the
 * rapid-batch UX identical across platforms — only the camera and the detector
 * are swapped.
 */
import { loadPlugin, isNativeApp } from "./platform";

/** Marks the page transparent so the OS camera preview shows through. */
export const SCANNING_CLASS = "native-scanning";

export type CameraPermission = "granted" | "denied" | "prompt";

export interface NativeScanSession {
  /** Tear down the listener, stop the camera, and restore the page background. */
  stop(): Promise<void>;
}

export interface NativeScanOptions {
  /** Fires for each detected barcode; may fire repeatedly for the same code. */
  onBarcode: (rawValue: string) => void;
  /** Camera to use. Defaults to the rear camera. */
  facing?: "back" | "front";
  /** Non-fatal scan errors, for surfacing guidance to the user. */
  onError?: (message: string) => void;
}

/**
 * Whether this device can scan natively. False on web, and false on a device
 * whose hardware or Play Services the plugin reports as unsupported — callers
 * fall back to the `BarcodeDetector` path in that case.
 */
export async function isNativeScanningAvailable(): Promise<boolean> {
  const plugin = await loadPlugin(() => import("@capacitor-mlkit/barcode-scanning"));
  if (!plugin) return false;
  try {
    const { supported } = await plugin.BarcodeScanner.isSupported();
    return supported;
  } catch {
    return false;
  }
}

/** Ask for camera access, returning the resulting state. "prompt" means undecided. */
export async function requestCameraPermission(): Promise<CameraPermission> {
  const plugin = await loadPlugin(() => import("@capacitor-mlkit/barcode-scanning"));
  if (!plugin) return "prompt";
  try {
    const status = await plugin.BarcodeScanner.requestPermissions();
    if (status.camera === "granted" || status.camera === "limited") return "granted";
    if (status.camera === "denied") return "denied";
    return "prompt";
  } catch {
    return "denied";
  }
}

/**
 * On Android the MLKit model ships through Google Play services rather than the
 * APK, which keeps the download small but means it can be missing on first run.
 * Installing it is a no-op once present, and unnecessary on iOS.
 */
interface AndroidModuleApi {
  isGoogleBarcodeScannerModuleAvailable(): Promise<{ available: boolean }>;
  installGoogleBarcodeScannerModule(): Promise<void>;
}

async function ensureAndroidModule(scanner: AndroidModuleApi): Promise<void> {
  try {
    const { available } = await scanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) await scanner.installGoogleBarcodeScannerModule();
  } catch {
    // Not an Android device, or the install failed — `startScan` still works
    // with the bundled detector on iOS and on Androids that already have it.
  }
}

/**
 * Start a continuous native scan. Returns null when native scanning isn't
 * available (web, unsupported device, denied permission) so the caller can use
 * its web fallback; the caller owns calling `stop()` on unmount.
 */
export async function startNativeScan(
  options: NativeScanOptions,
): Promise<NativeScanSession | null> {
  const plugin = await loadPlugin(() => import("@capacitor-mlkit/barcode-scanning"));
  if (!plugin) return null;

  const { BarcodeScanner, BarcodeFormat, LensFacing } = plugin;

  try {
    const { supported } = await BarcodeScanner.isSupported();
    if (!supported) return null;

    const status = await BarcodeScanner.requestPermissions();
    if (status.camera !== "granted" && status.camera !== "limited") return null;

    await ensureAndroidModule(BarcodeScanner);

    const listener = await BarcodeScanner.addListener("barcodesScanned", (event) => {
      for (const barcode of event.barcodes) {
        if (barcode.rawValue) options.onBarcode(barcode.rawValue);
      }
    });
    const errorListener = options.onError
      ? await BarcodeScanner.addListener("scanError", (event) => {
          options.onError?.(event.message);
        })
      : null;

    // The camera preview lives behind the WebView, so the page must not paint
    // over it. Set this only while scanning — the app is opaque everywhere else.
    document.documentElement.classList.add(SCANNING_CLASS);

    await BarcodeScanner.startScan({
      formats: [
        BarcodeFormat.UpcA,
        BarcodeFormat.UpcE,
        BarcodeFormat.Ean13,
        BarcodeFormat.Ean8,
      ],
      lensFacing: options.facing === "front" ? LensFacing.Front : LensFacing.Back,
    });

    let stopped = false;
    return {
      async stop() {
        if (stopped) return;
        stopped = true;
        document.documentElement.classList.remove(SCANNING_CLASS);
        await Promise.allSettled([
          listener.remove(),
          errorListener?.remove() ?? Promise.resolve(),
          BarcodeScanner.stopScan(),
        ]);
      },
    };
  } catch (err) {
    // Never leave the page transparent if startup failed partway through.
    document.documentElement.classList.remove(SCANNING_CLASS);
    console.warn("[native] barcode scan failed to start", err);
    return null;
  }
}

/** Whether the device's torch can be driven while a native scan is running. */
export async function isNativeTorchAvailable(): Promise<boolean> {
  const plugin = await loadPlugin(() => import("@capacitor-mlkit/barcode-scanning"));
  if (!plugin) return false;
  try {
    const { available } = await plugin.BarcodeScanner.isTorchAvailable();
    return available;
  } catch {
    return false;
  }
}

/**
 * Drive the torch during a native scan. Returns the state actually reached, so a
 * caller whose request failed can keep its button honest rather than lying about
 * a light that never came on.
 */
export async function setNativeTorch(on: boolean): Promise<boolean> {
  const plugin = await loadPlugin(() => import("@capacitor-mlkit/barcode-scanning"));
  if (!plugin) return false;
  try {
    if (on) await plugin.BarcodeScanner.enableTorch();
    else await plugin.BarcodeScanner.disableTorch();
    const { enabled } = await plugin.BarcodeScanner.isTorchEnabled();
    return enabled;
  } catch {
    return false;
  }
}

/**
 * Whether the *web* detector is usable here. Chromium-only, and deliberately
 * reported as unavailable inside the native shell so the MLKit path always wins.
 */
export function isWebDetectorAvailable(): boolean {
  if (typeof window === "undefined") return false;
  if (isNativeApp()) return false;
  return "BarcodeDetector" in window;
}

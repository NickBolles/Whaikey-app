/**
 * The single seam between the web app and the Capacitor runtime
 * (docs/NATIVE_APP.md §2.1). Nothing under `src/app` or `src/components` imports
 * `@capacitor/*` directly — everything goes through `src/lib/native/*`, which
 * guarantees two things:
 *
 *   1. The web build is unaffected. Plugins are loaded with dynamic `import()`
 *      only after we know we're on a device, so they never enter the browser
 *      bundle's critical path and never execute during SSR.
 *   2. Every capability has a documented web fallback, so a feature is written
 *      once and degrades instead of branching at the call site.
 */

export type NativePlatform = "ios" | "android";
export type Platform = NativePlatform | "web";

interface CapacitorGlobal {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  const global = (window as { Capacitor?: CapacitorGlobal }).Capacitor;
  return global ?? null;
}

/**
 * Which platform we're running on. Reads the global the Capacitor runtime
 * injects into the WebView rather than importing `@capacitor/core`, so this stays
 * synchronous and safe to call during render and on the server (where it is "web").
 */
export function platform(): Platform {
  const name = capacitor()?.getPlatform?.();
  return name === "ios" || name === "android" ? name : "web";
}

/** True only inside the iOS/Android app shell — false on the web and during SSR. */
export function isNativeApp(): boolean {
  return platform() !== "web";
}

export function isIos(): boolean {
  return platform() === "ios";
}

export function isAndroid(): boolean {
  return platform() === "android";
}

/**
 * Load a Capacitor plugin, but only on a device.
 *
 * Returns null on web, during SSR, and whenever the plugin fails to load —
 * a missing or broken plugin must degrade to the web fallback, never throw into
 * a render or an event handler. Callers treat null as "not available here".
 */
export async function loadPlugin<T>(load: () => Promise<T>): Promise<T | null> {
  if (!isNativeApp()) return null;
  try {
    return await load();
  } catch (err) {
    // A plugin that isn't installed in this build is an expected state (e.g. a
    // capability added to the web app before the native projects are rebuilt).
    console.warn("[native] plugin unavailable", err);
    return null;
  }
}

/**
 * Run `fn` only on a device, swallowing failures.
 *
 * Native chrome calls (status bar, splash, keyboard) are all fire-and-forget
 * polish: if one fails there is nothing useful to do, and it must never break
 * the surrounding flow.
 */
export async function nativeOnly(fn: () => Promise<unknown>): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await fn();
  } catch (err) {
    console.warn("[native] call failed", err);
  }
}

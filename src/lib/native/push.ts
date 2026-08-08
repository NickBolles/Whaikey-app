/**
 * Push notification registration (docs/NATIVE_APP.md §3.2).
 *
 * Only the device-side half lives here: ask permission, obtain the token, hand
 * it to the server. What gets *sent* is a product decision with a hard guardrail
 * — PLAN.md §7's responsible-drinking stance rules out anything that rewards
 * consumption frequency, so Whaikey never sends "time for a dram" nudges. The
 * legitimate categories are wishlist price alerts, blind-tasting invites,
 * catalog-verification results, and the yearly Wrapped.
 *
 * Permission is requested lazily by the caller, never on first launch: an app
 * that asks before it has earned anything gets denied, and iOS gives you exactly
 * one chance to ask.
 */
import { loadPlugin, platform } from "./platform";

export type PushPermission = "granted" | "denied" | "prompt" | "unavailable";

/** Where the app currently stands, without prompting. */
export async function pushPermissionState(): Promise<PushPermission> {
  const plugin = await loadPlugin(() => import("@capacitor/push-notifications"));
  if (!plugin) return "unavailable";
  try {
    const status = await plugin.PushNotifications.checkPermissions();
    if (status.receive === "granted") return "granted";
    if (status.receive === "denied") return "denied";
    return "prompt";
  } catch {
    return "unavailable";
  }
}

/**
 * Prompt for permission, register with APNs/FCM, and persist the token.
 *
 * Registration is event-driven on both platforms, so this waits for the
 * `registration` event rather than assuming `register()` resolving means a token
 * exists. Resolves to the permission outcome; a granted result with no token
 * (APNs unreachable, no Play services) still resolves rather than hanging.
 */
export async function enablePush(): Promise<PushPermission> {
  const plugin = await loadPlugin(() => import("@capacitor/push-notifications"));
  if (!plugin) return "unavailable";

  const { PushNotifications } = plugin;
  try {
    const status = await PushNotifications.requestPermissions();
    if (status.receive !== "granted") {
      return status.receive === "denied" ? "denied" : "prompt";
    }

    const token = await new Promise<string | null>((resolve) => {
      // Don't leave the caller waiting on a push service that never answers.
      const timer = setTimeout(() => resolve(null), 10_000);
      void PushNotifications.addListener("registration", ({ value }) => {
        clearTimeout(timer);
        resolve(value);
      });
      void PushNotifications.addListener("registrationError", () => {
        clearTimeout(timer);
        resolve(null);
      });
      void PushNotifications.register();
    });

    if (token) await storeToken(token);
    return "granted";
  } catch (err) {
    console.warn("[native] push registration failed", err);
    return "unavailable";
  }
}

/**
 * Hand the token to the server. Failures are swallowed: a device that couldn't
 * register this time will try again on the next launch, and a broken push
 * registration must never break the surrounding screen.
 */
async function storeToken(token: string): Promise<void> {
  try {
    await fetch("/api/native/push-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, platform: platform() }),
    });
  } catch {
    // Offline — retried on the next enablePush() call.
  }
}

/** Stop delivery to this device, e.g. on sign-out. */
export async function disablePush(): Promise<void> {
  const plugin = await loadPlugin(() => import("@capacitor/push-notifications"));
  if (!plugin) return;
  try {
    await plugin.PushNotifications.removeAllListeners();
    await fetch("/api/native/push-token", { method: "DELETE" }).catch(() => {});
  } catch {
    // Nothing actionable.
  }
}

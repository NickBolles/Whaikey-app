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
 * Re-register a device that has already granted permission (review SEC-M6).
 *
 * The server keeps a push token with the account that registered it until that
 * account releases it or **stops refreshing it**. Nothing was refreshing it:
 * `enablePush` runs once, at the moment somebody opts in, so every row aged
 * past the staleness window and became claimable by anyone holding the leaked
 * token — the original attack, delayed by a week rather than closed.
 *
 * So the shell says "still here" on every launch and resume. Never prompts:
 * an already-granted permission is re-registered, and everything else returns
 * without touching the OS, because iOS gives you exactly one chance to ask and
 * this is not the moment to spend it.
 */
export async function refreshPushRegistration(): Promise<void> {
  if ((await pushPermissionState()) !== "granted") return;
  const plugin = await loadPlugin(() => import("@capacitor/push-notifications"));
  if (!plugin) return;

  const { PushNotifications } = plugin;
  try {
    const token = await new Promise<string | null>((resolve) => {
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
  } catch {
    // A refresh that fails changes nothing: the row keeps its previous
    // timestamp and the next launch tries again.
  }
}

/**
 * Hand the token to the server. Failures are swallowed: a device that couldn't
 * register this time will try again on the next launch, and a broken push
 * registration must never break the surrounding screen.
 */
async function storeToken(token: string): Promise<void> {
  try {
    const res = await fetch("/api/native/push-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, platform: platform() }),
    });
    // Only remember a token the server accepted: a 409 means it belongs to
    // somebody else, and releasing it on our way out is not ours to do.
    if (res.ok) rememberToken(token);
  } catch {
    // Offline — retried on the next enablePush() call.
  }
}

/**
 * The last token this device registered.
 *
 * Kept so sign-out can release **this** device rather than every device on the
 * account. The tokenless DELETE means "all of mine", which on a phone signing
 * out would silently kill notifications on the owner's other phones — and free
 * those tokens for somebody else to claim.
 */
const LAST_TOKEN_KEY = "whaikey.push-token";

function rememberToken(token: string): void {
  try {
    window.localStorage.setItem(LAST_TOKEN_KEY, token);
  } catch {
    // Private mode or a full quota. The release below then falls back to
    // asking the OS, which is where the token came from anyway.
  }
}

function rememberedToken(): string | null {
  try {
    return window.localStorage.getItem(LAST_TOKEN_KEY);
  } catch {
    return null;
  }
}

function forgetToken(): void {
  try {
    window.localStorage.removeItem(LAST_TOKEN_KEY);
  } catch {
    // Nothing to do; the value is a cache, not a record.
  }
}

/**
 * Stop delivery to **this** device, e.g. on sign-out.
 *
 * Returns whether the server confirmed it. The caller needs to know: a
 * swallowed failure leaves the row live, so the account that just signed out
 * keeps receiving notifications on a device it no longer holds until the
 * staleness window closes.
 */
export async function disablePush(): Promise<boolean> {
  const plugin = await loadPlugin(() => import("@capacitor/push-notifications"));
  if (!plugin) return true;

  const token = rememberedToken();
  try {
    await plugin.PushNotifications.removeAllListeners();
  } catch {
    // Listener teardown is local tidying; the row is what matters.
  }

  // No token means this device never registered one, so there is nothing of
  // ours to release — and the tokenless DELETE would take somebody's other
  // phones with it.
  if (!token) return true;

  try {
    const res = await fetch(`/api/native/push-token?token=${encodeURIComponent(token)}`, {
      method: "DELETE",
    });
    if (!res.ok) return false;
    forgetToken();
    return true;
  } catch {
    return false;
  }
}

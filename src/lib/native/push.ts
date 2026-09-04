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

    const token = await resolveToken();
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
  const token = await resolveToken();
  if (token) await storeToken(token);
}

/**
 * Ask the OS for this install's token.
 *
 * The listeners are removed on every exit, win or lose. This runs on launch
 * *and* on every resume, and Capacitor listeners live until you remove them —
 * so keeping the handles is the difference between one pair and a pair per
 * foreground for the life of the app, with every registration event fanning
 * out through all of them.
 */
async function resolveToken(): Promise<string | null> {
  const plugin = await loadPlugin(() => import("@capacitor/push-notifications"));
  if (!plugin) return null;
  const { PushNotifications } = plugin;

  try {
    return await new Promise<string | null>((resolve) => {
      let done = false;
      const handles: Array<{ remove: () => void | Promise<void> }> = [];
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const handle of handles) void handle.remove();
        resolve(value);
      };
      // Don't leave the caller waiting on a push service that never answers.
      const timer = setTimeout(() => finish(null), 10_000);

      void PushNotifications.addListener("registration", ({ value }) => finish(value)).then(
        (handle) => (done ? void handle.remove() : handles.push(handle)),
      );
      void PushNotifications.addListener("registrationError", () => finish(null)).then(
        (handle) => (done ? void handle.remove() : handles.push(handle)),
      );
      void PushNotifications.register();
    });
  } catch {
    return null;
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

  try {
    await plugin.PushNotifications.removeAllListeners();
  } catch {
    // Listener teardown is local tidying; the row is what matters.
  }

  /**
   * Which token is ours.
   *
   * The remembered one first, then the OS. The cache can be missing for two
   * very different reasons — this device never registered, or local storage
   * was cleared or refused — and treating the second as the first would report
   * a release that never happened and leave the row live on a shared device.
   * Only a device that has not been granted permission has genuinely nothing
   * to release.
   */
  let token = rememberedToken();
  if (!token) {
    // A device that was never granted permission has nothing registered, which
    // is the one case where "no token" really is "nothing to release".
    if ((await pushPermissionState()) !== "granted") return true;
    token = await resolveToken();
  }
  // Granted, but we could not find out which token is ours — that is a failure
  // to release, not a successful no-op.
  if (!token) return false;

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

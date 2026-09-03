/**
 * Native sign-in (docs/NATIVE_APP.md §2.3).
 *
 * Google returns `disallowed_useragent` for OAuth started inside an embedded
 * WebView, so on a device the flow has to leave the app: open the system browser,
 * let it complete OAuth, come back through the `whaikey://` scheme with a
 * one-time code, and redeem that code by navigating the WebView itself — which is
 * what puts the session cookie in the right jar.
 *
 * That last leg is over a channel nobody owns. `whaikey://` is a custom scheme
 * any app on the device can register, so this module assumes an inbound
 * callback is hostile until proven otherwise (SEC-H1):
 *
 *   - a **state** nonce, minted here and kept on the device, has to come back
 *     for the callback to be acted on at all — otherwise an attacker could push
 *     a code of their own at the app and silently swap the user into their
 *     account, where every pour the user logged afterwards would land;
 *   - a **PKCE verifier**, minted here and never sent anywhere but the exchange,
 *     is what actually redeems the code — so a code intercepted by another app
 *     that claimed the same scheme is worth nothing.
 */
import { loadPlugin } from "./platform";
import { deepLinkPath } from "./app-lifecycle";

export type NativeSignInResult =
  | { status: "unavailable" }
  | { status: "started" }
  | { status: "failed"; reason: string };

/** Where the in-flight state/verifier live across the browser round trip. */
const PENDING_KEY = "whaikey.native-auth.pending.v1";

interface PendingSignIn {
  state: string;
  verifier: string;
}

/** Errors `/api/auth/native/complete` can hand back, in words a user can act on. */
const ERROR_MESSAGES: Record<string, string> = {
  not_signed_in: "Sign-in was cancelled.",
  no_session_cookie: "Sign-in didn't complete. Please try again.",
  exchange_failed: "Sign-in didn't complete. Please try again.",
  // The sign-in took too long, or the callback arrived a second time.
  no_request: "Sign-in expired. Please try again.",
};

export function describeNativeAuthError(code: string | null): string | null {
  if (!code) return null;
  return ERROR_MESSAGES[code] ?? "Sign-in failed. Please try again.";
}

/**
 * Pull the exchange code (or error) out of a `whaikey://auth/callback` deep link.
 * Returns null for any link that isn't the auth callback, so the shell's generic
 * deep-link routing keeps handling everything else.
 */
export function parseAuthCallback(
  url: string,
): AuthCallback | null {
  const path = deepLinkPath(url);
  if (!path || !path.startsWith("/auth/callback")) return null;

  const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const code = params.get("code");
  const next = params.get("next") ?? undefined;
  const state = params.get("state") ?? undefined;
  if (code) {
    return { code, ...(state ? { state } : {}), ...(next ? { next } : {}) };
  }
  // Errors keep the return target too: the retry sign-in should still land on
  // the scanned page rather than sending the person back to their camera.
  const error = params.get("error") ?? "unknown";
  return { error, ...(state ? { state } : {}), ...(next ? { next } : {}) };
}

export type AuthCallback =
  | { code: string; state?: string; next?: string }
  | { error: string; state?: string; next?: string };

/** The in-WebView URL that turns an exchange code into a session cookie. */
export function exchangeUrl(code: string, verifier: string, next?: string): string {
  const base =
    `/api/auth/native/exchange?code=${encodeURIComponent(code)}` +
    `&code_verifier=${encodeURIComponent(verifier)}`;
  // The server re-validates `next` (safeReturnPath) before redirecting to it.
  return next ? `${base}&next=${encodeURIComponent(next)}` : base;
}

/** 32 bytes of base64url. No non-crypto fallback: these two values are the
 *  whole defence, and a predictable one is worse than no sign-in at all. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** base64url(SHA-256(verifier)) — PKCE S256, matching `codeChallengeFor`. */
async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The state and verifier have to outlive the trip to the browser and back, and
 * on iOS the app may be evicted while the user is in it — so Preferences, not
 * memory. `localStorage` is the web fallback, which keeps this testable; the
 * flow itself never runs there.
 */
async function savePending(pending: PendingSignIn): Promise<void> {
  const value = JSON.stringify(pending);
  const plugin = await loadPlugin(() => import("@capacitor/preferences"));
  if (plugin) {
    await plugin.Preferences.set({ key: PENDING_KEY, value });
    return;
  }
  try {
    localStorage.setItem(PENDING_KEY, value);
  } catch {
    // Storage disabled: takePending will find nothing and the callback is
    // dropped, which is the safe direction.
  }
}

/**
 * Read the in-flight sign-in *without* consuming it.
 *
 * Reading and clearing in one step looked tidier and handed anyone who can
 * launch `whaikey://` a cancel button: a forged callback arriving mid-flow
 * would take the verifier away, and the real callback moments later would find
 * nothing to match and be ignored. So the state is compared first and
 * `clearPendingSignIn` runs only on a match — a mismatched callback now costs
 * the attacker nothing and the user nothing.
 */
export async function readPendingSignIn(): Promise<PendingSignIn | null> {
  let raw: string | null = null;
  const plugin = await loadPlugin(() => import("@capacitor/preferences"));
  if (plugin) {
    raw = (await plugin.Preferences.get({ key: PENDING_KEY })).value;
  } else {
    try {
      raw = localStorage.getItem(PENDING_KEY);
    } catch {
      return null;
    }
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PendingSignIn).state === "string" &&
      typeof (parsed as PendingSignIn).verifier === "string"
    ) {
      return parsed as PendingSignIn;
    }
  } catch {
    // Corrupt storage reads as no pending sign-in.
  }
  return null;
}

/**
 * Consume the in-flight sign-in. Called once the callback has been matched, so
 * a replayed link finds nothing — the server's code is single-use too, but the
 * app should not be trying to spend it twice either.
 */
export async function clearPendingSignIn(): Promise<void> {
  const plugin = await loadPlugin(() => import("@capacitor/preferences"));
  if (plugin) {
    await plugin.Preferences.remove({ key: PENDING_KEY });
    return;
  }
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/**
 * Whether an inbound callback is the one this app started.
 *
 * Length-independent comparison isn't the concern here — both values are
 * already on the device — but a missing or mismatched state absolutely is: it
 * means someone else's `whaikey://` link, and the only correct response is to
 * ignore it.
 */
export function statesMatch(expected: string, received: string | undefined): boolean {
  return typeof received === "string" && received.length > 0 && received === expected;
}

/**
 * Begin native sign-in by opening the system browser.
 *
 * Returns "unavailable" on the web so the caller falls back to the normal
 * in-page Better Auth flow — the browser has no WebView problem to work around.
 */
export async function startNativeSignIn(
  provider: "google" | "apple",
  next?: string,
): Promise<NativeSignInResult> {
  const plugin = await loadPlugin(() => import("@capacitor/browser"));
  if (!plugin) return { status: "unavailable" };

  let challenge: string;
  const pending: PendingSignIn = { state: randomToken(), verifier: randomToken() };
  try {
    challenge = await challengeFor(pending.verifier);
  } catch (err) {
    // WebCrypto is unavailable outside a secure context. The app is served over
    // https, so this shouldn't happen — and if it does, signing in without PKCE
    // is not the fallback.
    console.warn("[native] cannot derive a PKCE challenge", err);
    return { status: "failed", reason: "Couldn't start a secure sign-in on this device." };
  }
  await savePending(pending);

  const params = new URLSearchParams({
    provider,
    code_challenge: challenge,
    state: pending.state,
  });
  // `next` rides along so a scanned /add link survives the OAuth round trip;
  // the server validates it as a same-origin path and parks it server-side.
  if (next) params.set("next", next);

  try {
    await plugin.Browser.open({
      // Absolute: the system browser has no notion of the WebView's base URL.
      // The WebView is served from the app origin, so this is the deployed site.
      url: `${window.location.origin}/api/auth/native/start?${params.toString()}`,
      // ASWebAuthenticationSession / Chrome Custom Tabs: a real browser as far as
      // Google is concerned, but presented inside the app.
      presentationStyle: "popover",
    });
    return { status: "started" };
  } catch (err) {
    console.warn("[native] could not open the sign-in browser", err);
    return { status: "failed", reason: "Couldn't open the browser to sign in." };
  }
}

/** Close the system browser once the callback has been received. */
export async function closeNativeSignIn(): Promise<void> {
  const plugin = await loadPlugin(() => import("@capacitor/browser"));
  await plugin?.Browser.close().catch(() => {});
}

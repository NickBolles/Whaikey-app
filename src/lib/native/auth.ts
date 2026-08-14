/**
 * Native sign-in (docs/NATIVE_APP.md §2.3).
 *
 * Google returns `disallowed_useragent` for OAuth started inside an embedded
 * WebView, so on a device the flow has to leave the app: open the system browser,
 * let it complete OAuth, come back through the `whaikey://` scheme with a
 * one-time code, and redeem that code by navigating the WebView itself — which is
 * what puts the session cookie in the right jar.
 */
import { loadPlugin } from "./platform";
import { deepLinkPath } from "./app-lifecycle";

export type NativeSignInResult =
  | { status: "unavailable" }
  | { status: "started" }
  | { status: "failed"; reason: string };

/** Errors `/api/auth/native/complete` can hand back, in words a user can act on. */
const ERROR_MESSAGES: Record<string, string> = {
  not_signed_in: "Sign-in was cancelled.",
  no_session_cookie: "Sign-in didn't complete. Please try again.",
  exchange_failed: "Sign-in didn't complete. Please try again.",
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
): { code: string; next?: string } | { error: string; next?: string } | null {
  const path = deepLinkPath(url);
  if (!path || !path.startsWith("/auth/callback")) return null;

  const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const code = params.get("code");
  const next = params.get("next") ?? undefined;
  if (code) {
    return next ? { code, next } : { code };
  }
  // Errors keep the return target too: the retry sign-in should still land on
  // the scanned page rather than sending the person back to their camera.
  const error = params.get("error") ?? "unknown";
  return next ? { error, next } : { error };
}

/** The in-WebView URL that turns an exchange code into a session cookie. */
export function exchangeUrl(code: string, next?: string): string {
  const base = `/api/auth/native/exchange?code=${encodeURIComponent(code)}`;
  // The server re-validates `next` (safeReturnPath) before redirecting to it.
  return next ? `${base}&next=${encodeURIComponent(next)}` : base;
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

  try {
    await plugin.Browser.open({
      // Absolute: the system browser has no notion of the WebView's base URL.
      // The WebView is served from the app origin, so this is the deployed site.
      // `next` rides along so a scanned /add link survives the OAuth round
      // trip; every server hop re-validates it as a same-origin path.
      url: `${window.location.origin}/api/auth/native/start?provider=${provider}${next ? `&next=${encodeURIComponent(next)}` : ""}`,
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

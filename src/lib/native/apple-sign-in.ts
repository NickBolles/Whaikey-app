/**
 * Native Sign in with Apple on iOS (M3.3; App Store guideline 4.8).
 *
 * Google sign-in has to leave the app for the system browser (see ./auth.ts),
 * but Apple's sheet is a native `ASAuthorizationController` and needs no
 * browser at all: the app plugin (ios/App/App/WhaikeyAppleSignInPlugin.swift)
 * hands back an id token, and this module posts it to Better Auth from inside
 * the WebView, so the session cookie lands in the WebView's own jar.
 *
 *   1. GET /api/auth/native/apple/nonce → a nonce the server minted (404 when
 *      the server has no Apple bundle id configured — fall back to the browser).
 *   2. Apple gets `sha256(nonce)`, and signs it into the id token.
 *   3. POST /api/auth/sign-in/social { provider: "apple", idToken: { token, nonce } };
 *      the server refuses any nonce it did not mint (src/lib/apple-sign-in.ts).
 *
 * Returns "unavailable" whenever this path cannot run — the web, Android, an
 * older shell without the plugin, or a server without Apple configured — and
 * the caller falls back to the system-browser flow it already had.
 */
import { isIos, loadPlugin } from "./platform";

export const APPLE_PLUGIN = "WhaikeyAppleSignIn";

export type AppleSignInResult =
  | { status: "unavailable" }
  | { status: "cancelled" }
  | { status: "signed-in" }
  | { status: "failed"; reason: string };

interface AppleCredential {
  identityToken: string;
  /** Apple sends the name and email only on the very first authorization. */
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
}

interface WhaikeyAppleSignInPlugin {
  authorize(options: { nonce: string }): Promise<AppleCredential>;
}

interface CapacitorProbe {
  isPluginAvailable?: (name: string) => boolean;
}

/** Whether this build carries the native plugin. False on the web, Android and older shells. */
export function isNativeAppleAvailable(): boolean {
  if (!isIos()) return false;
  const cap = (window as { Capacitor?: CapacitorProbe }).Capacitor;
  try {
    return cap?.isPluginAvailable?.(APPLE_PLUGIN) === true;
  } catch {
    return false;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isCancel(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "canceled" || code === "cancelled";
}

export async function signInWithAppleNative(): Promise<AppleSignInResult> {
  if (!isNativeAppleAvailable()) return { status: "unavailable" };

  let nonce: string;
  try {
    const res = await fetch("/api/auth/native/apple/nonce", { cache: "no-store" });
    // Not configured on this server: the browser flow is the honest fallback.
    if (res.status === 404) return { status: "unavailable" };
    if (!res.ok) throw new Error(String(res.status));
    nonce = ((await res.json()) as { nonce: string }).nonce;
  } catch {
    return { status: "failed", reason: "Couldn't reach the sign-in service. Check your connection and try again." };
  }

  const plugin = await loadPlugin(async () => {
    const { registerPlugin } = await import("@capacitor/core");
    return registerPlugin<WhaikeyAppleSignInPlugin>(APPLE_PLUGIN);
  });
  if (!plugin) return { status: "unavailable" };

  let credential: AppleCredential;
  try {
    credential = await plugin.authorize({ nonce: await sha256Hex(nonce) });
  } catch (err) {
    if (isCancel(err)) return { status: "cancelled" };
    console.warn("[native] Sign in with Apple failed", err);
    return { status: "failed", reason: "Sign in with Apple didn't complete. Please try again." };
  }
  if (!credential?.identityToken) {
    return { status: "failed", reason: "Sign in with Apple didn't complete. Please try again." };
  }

  const name =
    credential.givenName || credential.familyName
      ? { firstName: credential.givenName ?? "", lastName: credential.familyName ?? "" }
      : undefined;
  try {
    const res = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        provider: "apple",
        idToken: {
          token: credential.identityToken,
          nonce,
          ...(name ? { user: { name, ...(credential.email ? { email: credential.email } : {}) } } : {}),
        },
      }),
    });
    if (!res.ok) {
      return { status: "failed", reason: "Sign in with Apple didn't complete. Please try again." };
    }
    return { status: "signed-in" };
  } catch {
    return { status: "failed", reason: "Couldn't reach the sign-in service. Check your connection and try again." };
  }
}

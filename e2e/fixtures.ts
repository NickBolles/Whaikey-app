import { webcrypto } from "node:crypto";
import type { BrowserContext } from "@playwright/test";

export const E2E_SECRET = "e2e-secret";
export const DEMO_USER_ID = "demo-user";
export const DEMO_SESSION_TOKEN = "e2e-demo-session-token";
/**
 * Separate user for tests that MUTATE shelf data (e.g. the scan flow), so the
 * demo collector's bar stays exactly as seeded for the visual baselines.
 */
export const SCAN_USER_ID = "scan-user";
export const SCAN_SESSION_TOKEN = "e2e-scan-session-token";
const SESSION_COOKIE = "better-auth.session_token";

/**
 * Mint a Better Auth signed session cookie value: `${token}.${base64 HMAC}`
 * URL-encoded (matches better-call's signCookieValue). Requires the session
 * row to exist in the DB (created by global-setup's demo seed).
 */
export async function mintSessionCookieValue(
  token: string = DEMO_SESSION_TOKEN,
  secret: string = E2E_SECRET,
): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  const b64 = Buffer.from(new Uint8Array(sig)).toString("base64");
  return encodeURIComponent(`${token}.${b64}`);
}

export async function signIn(
  context: BrowserContext,
  baseURL: string,
  token: string = DEMO_SESSION_TOKEN,
): Promise<void> {
  const value = await mintSessionCookieValue(token);
  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

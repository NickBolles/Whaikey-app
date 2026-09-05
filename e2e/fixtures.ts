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
/**
 * Signed-in accounts that have never answered the age gate (PLAN.md §9.1) —
 * the only way to exercise the gate end to end, since every other fixture user
 * is seeded through it.
 *
 * There are two because the answer is deliberately once-per-account: a test
 * that answers has used its account up, so the pass path and the block path
 * cannot share one.
 */
export const GATE_USER_ID = "gate-user";
export const GATE_SESSION_TOKEN = "e2e-gate-session-token";
export const GATE_MINOR_USER_ID = "gate-minor-user";
export const GATE_MINOR_SESSION_TOKEN = "e2e-gate-minor-session-token";
/**
 * The one account on the operator allowlist (`WHAIKEY_OPERATOR_IDS` is set to
 * this id in playwright.config.ts). Separate from the demo collector because
 * being an operator changes what a page returns, and Jordan's screens are the
 * visual baselines.
 */
export const OPERATOR_USER_ID = "operator-user";
export const OPERATOR_SESSION_TOKEN = "e2e-operator-session-token";
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

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { apple } from "better-auth/social-providers";

/**
 * Sign in with Apple — the server half (docs/NATIVE_APP.md §2.3.1, M3.3).
 *
 * Two ways in, one Better Auth provider:
 *
 *   - **Web** keeps the redirect flow: `APPLE_CLIENT_ID` is the Services ID and
 *     `APPLE_CLIENT_SECRET` the signed client-secret JWT. The id token Apple
 *     issues there has the Services ID as its audience.
 *   - **iOS** runs `ASAuthorizationController` natively and posts the id token
 *     it gets straight to `/api/auth/sign-in/social` (`idToken: { token, nonce }`)
 *     from inside the WebView, so the session cookie lands in the WebView's jar
 *     with no browser round trip. That token's audience is the **bundle id**,
 *     `APPLE_APP_BUNDLE_IDENTIFIER`.
 *
 * The provider is registered when either half is configured, and accepts a
 * token addressed to whichever of the two ids are set — never anything else.
 *
 * **Nonce, required and ours.** Better Auth only compares a nonce when the
 * request carries one: an id-token request with no nonce at all is verified on
 * signature, issuer, audience and age alone, which makes any Apple token for
 * this app that leaks within its hour a session. So the id-token path here
 * refuses a request without a nonce, and refuses a nonce this server did not
 * mint in the last few minutes (an HMAC under `BETTER_AUTH_SECRET`, stateless,
 * so no table and no migration). The device hands Apple `sha256(nonce)`; Apple
 * signs that into the token; Better Auth checks the token's claim against the
 * hash of the raw nonce posted back. A token minted for one sign-in attempt is
 * therefore only redeemable with that attempt's nonce, and only briefly.
 */

/** How long a minted nonce stays redeemable. Long enough for Face ID and a slow network. */
export const APPLE_NONCE_TTL_MS = 10 * 60 * 1000;

type Env = Record<string, string | undefined>;

export interface AppleConfig {
  /** Services ID for the web redirect flow, when configured. */
  servicesId: string | null;
  /** Services ID secret (a signed JWT), when configured. */
  clientSecret: string | null;
  /** iOS bundle id, the audience of a natively issued token. */
  bundleId: string | null;
}

export function appleConfig(env: Env = process.env): AppleConfig | null {
  const servicesId = env.APPLE_CLIENT_ID?.trim() || null;
  const clientSecret = env.APPLE_CLIENT_SECRET?.trim() || null;
  const bundleId = env.APPLE_APP_BUNDLE_IDENTIFIER?.trim() || null;
  const web = Boolean(servicesId && clientSecret);
  if (!web && !bundleId) return null;
  return {
    servicesId: web ? servicesId : null,
    clientSecret: web ? clientSecret : null,
    bundleId,
  };
}

/** True when the native (id-token) path can succeed: a bundle id to check the audience against. */
export function isNativeAppleConfigured(env: Env = process.env): boolean {
  return Boolean(appleConfig(env)?.bundleId);
}

function nonceKey(secret: string): Buffer {
  // Domain-separated from every other use of the auth secret.
  return createHmac("sha256", secret).update("whaikey.apple-nonce.v1").digest();
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", nonceKey(secret)).update(payload).digest("base64url");
}

/** `<issuedAtMs>.<random>.<hmac>` — opaque to the device, checkable here. */
export function mintAppleNonce(secret: string, now: number = Date.now()): string {
  const payload = `${now.toString(36)}.${randomBytes(18).toString("base64url")}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyAppleNonce(
  nonce: string | undefined,
  secret: string,
  now: number = Date.now(),
): boolean {
  if (typeof nonce !== "string" || nonce.length > 200) return false;
  const parts = nonce.split(".");
  if (parts.length !== 3) return false;
  const [issued, random, mac] = parts;
  if (!/^[0-9a-z]{1,12}$/.test(issued) || !/^[A-Za-z0-9_-]{24}$/.test(random)) return false;
  const expected = Buffer.from(sign(`${issued}.${random}`, secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const issuedAt = parseInt(issued, 36);
  // A small allowance for clock skew between instances, none for the future beyond it.
  return issuedAt <= now + 30_000 && now - issuedAt <= APPLE_NONCE_TTL_MS;
}

/**
 * Better Auth options for the Apple provider, or null when Apple is not configured.
 *
 * `clientSecret` may be empty on a native-only configuration: the redirect flow
 * then fails with Better Auth's own "client secret required" error, which is
 * the truth, while the id-token path still works.
 */
export function appleProviderOptions(secret: string, env: Env = process.env) {
  const config = appleConfig(env);
  if (!config) return null;
  const audience = [config.servicesId, config.bundleId].filter((v): v is string => Boolean(v));
  const base = {
    clientId: config.servicesId ?? config.bundleId ?? "",
    clientSecret: config.clientSecret ?? "",
    ...(config.bundleId ? { appBundleIdentifier: config.bundleId } : {}),
    audience,
  };
  // Better Auth's own verification (Apple JWKS, issuer, audience, 1h max age,
  // sha256(nonce) claim), wrapped so it never runs without a nonce we minted.
  const reference = apple(base);
  return {
    ...base,
    verifyIdToken: async (token: string, nonce: string | undefined): Promise<boolean> => {
      if (!verifyAppleNonce(nonce, secret)) return false;
      return reference.verifyIdToken(token, nonce);
    },
  };
}

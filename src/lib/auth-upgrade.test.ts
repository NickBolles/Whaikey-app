import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getCookies } from "better-auth/cookies";
import { schema } from "@/db";
import type { DB } from "@/db";
import { setupTestDb } from "@/test/helpers";

/**
 * The Better Auth 1.6 → 1.7 upgrade (GHSA-965c-763c-88jm), exercised through
 * the app's real `auth` instance rather than a copy of its options:
 *
 *   - people signed in before the deploy stay signed in (same cookie names,
 *     same signing, same session table), and
 *   - the Google redirect flow still starts and completes, with the provider's
 *     endpoints faked at `fetch`.
 *
 * Native Apple id-token sign-in is covered in `apple-sign-in.test.ts`, which
 * drives the real endpoint with a fake Apple JWKS.
 */
const SECRET = "upgrade-test-secret-at-least-32-characters!!";
const BASE = "http://localhost:3000";
const GOOGLE_ID = "test-client.apps.googleusercontent.com";

/**
 * A session cookie exactly as Better Auth 1.6 (better-call 1.3) wrote it:
 * `encodeURIComponent(token + "." + base64(HMAC-SHA256(secret, token)))`.
 * Written out by hand so the test pins the pre-upgrade format instead of
 * asking the new version to agree with itself.
 */
function legacySignedCookie(token: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(token).digest("base64");
  return encodeURIComponent(`${token}.${sig}`);
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

/** `name=value` pairs from Set-Cookie headers, ready to send back as `Cookie`. */
function cookieHeader(res: Response): string {
  return setCookies(res)
    .map((c) => c.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "k" })}.${b64(claims)}.sig`;
}

describe("Better Auth 1.7 upgrade", () => {
  let db: DB;

  beforeEach(async () => {
    db = await setupTestDb();
    vi.resetModules();
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    vi.stubEnv("BETTER_AUTH_URL", BASE);
    vi.stubEnv("GOOGLE_CLIENT_ID", GOOGLE_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
    vi.stubEnv("APPLE_CLIENT_ID", "");
    vi.stubEnv("APPLE_CLIENT_SECRET", "");
    vi.stubEnv("APPLE_APP_BUNDLE_IDENTIFIER", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function loadAuth() {
    return (await import("@/lib/auth")).auth;
  }

  describe("cookies (nobody is signed out by the deploy)", () => {
    it("keeps the 1.6 cookie names, with the __Secure- prefix on https", async () => {
      const auth = await loadAuth();
      expect(getCookies(auth.options).sessionToken.name).toBe("better-auth.session_token");
      expect(getCookies({ ...auth.options, baseURL: "https://whaikey-app.vercel.app" }).sessionToken.name).toBe(
        "__Secure-better-auth.session_token",
      );
      // No `advanced` block at all: no cookiePrefix / cookie-name override to drift.
      expect("advanced" in auth.options).toBe(false);
    });

    it("honours a session cookie signed the way 1.6 signed it", async () => {
      const auth = await loadAuth();
      const userId = "u_legacy";
      const token = randomBytes(24).toString("base64url");
      const now = new Date();
      await db.insert(schema.user).values({
        id: userId,
        name: "Legacy Taster",
        email: "legacy@example.com",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(schema.session).values({
        id: "s_legacy",
        token,
        userId,
        expiresAt: new Date(now.getTime() + 86_400_000),
        createdAt: now,
        updatedAt: now,
      });

      const session = await auth.api.getSession({
        headers: new Headers({ cookie: `better-auth.session_token=${legacySignedCookie(token, SECRET)}` }),
      });
      expect(session?.user.id).toBe(userId);

      const forged = await auth.api.getSession({
        headers: new Headers({ cookie: `better-auth.session_token=${legacySignedCookie(token, "other-secret")}` }),
      });
      expect(forged).toBeNull();
    });
  });

  describe("Google redirect sign-in", () => {
    async function start(auth: Awaited<ReturnType<typeof loadAuth>>) {
      const res = await auth.handler(
        new Request(`${BASE}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify({ provider: "google", callbackURL: "/home" }),
        }),
      );
      expect(res.status).toBe(200);
      const { url } = (await res.json()) as { url: string };
      return { res, url: new URL(url) };
    }

    it("starts at Google with PKCE, a state and our callback", async () => {
      const auth = await loadAuth();
      const { res, url } = await start(auth);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(url.searchParams.get("client_id")).toBe(GOOGLE_ID);
      expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/google`);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("state")).toBeTruthy();
      expect(setCookies(res).some((c) => c.startsWith("better-auth.state="))).toBe(true);
    });

    it("completes the callback into an account and a session", async () => {
      const auth = await loadAuth();
      const { res: started, url } = await start(auth);
      const state = url.searchParams.get("state")!;
      const now = Math.floor(Date.now() / 1000);
      const idToken = unsignedJwt({
        iss: "https://accounts.google.com",
        aud: GOOGLE_ID,
        sub: "google-sub-42",
        email: "google-taster@example.com",
        email_verified: true,
        name: "Google Taster",
        iat: now,
        exp: now + 600,
      });
      const realFetch = globalThis.fetch;
      const tokenRequests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (href.startsWith("https://oauth2.googleapis.com/token")) {
            tokenRequests.push(String(init?.body ?? ""));
            return Response.json({
              access_token: "ya29.fake",
              id_token: idToken,
              expires_in: 3600,
              token_type: "Bearer",
              scope: "openid email profile",
            });
          }
          return realFetch(input, init);
        }),
      );

      const callback = await auth.handler(
        new Request(`${BASE}/api/auth/callback/google?code=fake-code&state=${encodeURIComponent(state)}`, {
          headers: { cookie: cookieHeader(started) },
        }),
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("/home");
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]).toContain("code_verifier=");
      expect(setCookies(callback).some((c) => c.startsWith("better-auth.session_token="))).toBe(true);

      const [account] = await db.select().from(schema.account).where(eq(schema.account.accountId, "google-sub-42"));
      expect(account?.providerId).toBe("google");
      const session = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader(callback) }) });
      expect(session?.user.email).toBe("google-taster@example.com");
    });

    it("refuses a callback whose state was never issued", async () => {
      const auth = await loadAuth();
      const res = await auth.handler(new Request(`${BASE}/api/auth/callback/google?code=x&state=not-ours`));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/error=/);
      expect(setCookies(res).some((c) => c.startsWith("better-auth.session_token=") && !c.startsWith("better-auth.session_token=;"))).toBe(false);
    });
  });

  it("ships no Magic Link endpoint, the other half of GHSA-965c-763c-88jm", async () => {
    const auth = await loadAuth();
    const res = await auth.handler(new Request(`${BASE}/api/auth/magic-link/verify?token=anything`));
    expect(res.status).toBe(404);
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
  });
});

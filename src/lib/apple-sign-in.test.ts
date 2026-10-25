import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { DB } from "@/db";
import { setupTestDb } from "@/test/helpers";
import {
  APPLE_NONCE_TTL_MS,
  appleConfig,
  appleProviderOptions,
  isNativeAppleConfigured,
  mintAppleNonce,
  verifyAppleNonce,
} from "./apple-sign-in";

/**
 * Native Sign in with Apple, server side: the id token a device posts is run
 * through the real Better Auth sign-in endpoint, against a fake Apple JWKS, so
 * what is tested is the provider configuration this app ships — not a mock of it.
 */
const SECRET = "test-secret-at-least-32-characters-long!!";
const BUNDLE = "com.whaikey.app";
const SERVICES = "com.whaikey.web";
const KID = "test-kid";

let privateKey: KeyObject;
let jwk: Record<string, unknown>;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
});

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

function appleIdToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: KID }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: BUNDLE,
      sub: "001234.apple-user.5678",
      email: "taster@privaterelay.appleid.com",
      email_verified: "true",
      is_private_email: "true",
      iat: now,
      exp: now + 600,
      ...claims,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKey))}`;
}

describe("Apple configuration", () => {
  it("is off with nothing set, and with only half of the web pair", () => {
    expect(appleConfig({})).toBeNull();
    expect(appleConfig({ APPLE_CLIENT_ID: SERVICES })).toBeNull();
    expect(isNativeAppleConfigured({ APPLE_CLIENT_ID: SERVICES, APPLE_CLIENT_SECRET: "jwt" })).toBe(false);
  });

  it("accepts tokens for exactly the ids that are configured", () => {
    const both = appleProviderOptions(SECRET, {
      APPLE_CLIENT_ID: SERVICES,
      APPLE_CLIENT_SECRET: "jwt",
      APPLE_APP_BUNDLE_IDENTIFIER: BUNDLE,
    });
    expect(both?.audience).toEqual([SERVICES, BUNDLE]);
    const nativeOnly = appleProviderOptions(SECRET, { APPLE_APP_BUNDLE_IDENTIFIER: BUNDLE });
    expect(nativeOnly?.audience).toEqual([BUNDLE]);
    expect(nativeOnly?.clientId).toBe(BUNDLE);
    expect(isNativeAppleConfigured({ APPLE_APP_BUNDLE_IDENTIFIER: BUNDLE })).toBe(true);
  });
});

describe("nonces", () => {
  it("verifies one this server minted, within its lifetime", () => {
    const now = Date.now();
    const nonce = mintAppleNonce(SECRET, now);
    expect(verifyAppleNonce(nonce, SECRET, now + 1000)).toBe(true);
    expect(verifyAppleNonce(nonce, SECRET, now + APPLE_NONCE_TTL_MS + 1)).toBe(false);
  });

  it("refuses a missing, forged, re-keyed or tampered nonce", () => {
    const nonce = mintAppleNonce(SECRET);
    expect(verifyAppleNonce(undefined, SECRET)).toBe(false);
    expect(verifyAppleNonce("", SECRET)).toBe(false);
    expect(verifyAppleNonce("any-string-the-device-made-up", SECRET)).toBe(false);
    expect(verifyAppleNonce(nonce, "a-different-secret-entirely-000000000")).toBe(false);
    const [issued, random, mac] = nonce.split(".");
    // Pushing the issue time forward to extend its life breaks the MAC.
    const later = (parseInt(issued, 36) + 60_000).toString(36);
    expect(verifyAppleNonce(`${later}.${random}.${mac}`, SECRET)).toBe(false);
  });

  it("refuses a nonce dated in the future", () => {
    const now = Date.now();
    expect(verifyAppleNonce(mintAppleNonce(SECRET, now + 5 * 60_000), SECRET, now)).toBe(false);
  });
});

describe("id-token sign-in through Better Auth", () => {
  let db: DB;
  let auth: ReturnType<typeof makeAuth>;

  function makeAuth() {
    const apple = appleProviderOptions(SECRET, { APPLE_APP_BUNDLE_IDENTIFIER: BUNDLE });
    if (!apple) throw new Error("apple not configured");
    return betterAuth({
      database: drizzleAdapter(db, { provider: "pg", schema }),
      secret: SECRET,
      baseURL: "http://localhost:3000",
      emailAndPassword: { enabled: false },
      socialProviders: { apple },
      logger: { disabled: true },
    });
  }

  beforeEach(async () => {
    db = await setupTestDb();
    auth = makeAuth();
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://appleid.apple.com/auth/keys")) {
          return new Response(JSON.stringify({ keys: [jwk] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return realFetch(input, init);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function signIn(idToken: { token: string; nonce?: string }) {
    return auth.api.signInSocial({
      body: { provider: "apple", idToken },
      headers: new Headers(),
      asResponse: true,
    });
  }

  it("creates the account and a session for a valid token and fresh nonce", async () => {
    const nonce = mintAppleNonce(SECRET);
    const res = await signIn({ token: appleIdToken({ nonce: sha256Hex(nonce) }), nonce });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token");
    const [account] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.accountId, "001234.apple-user.5678"));
    expect(account?.providerId).toBe("apple");
  });

  it("refuses a valid token posted without a nonce", async () => {
    // Better Auth alone would accept this: it only checks a nonce it is given.
    const res = await signIn({ token: appleIdToken({ nonce: sha256Hex("whatever") }) });
    expect(res.status).toBe(401);
  });

  it("refuses a nonce the server never minted, even if it matches the token", async () => {
    const forged = "device-made-this-up";
    const res = await signIn({ token: appleIdToken({ nonce: sha256Hex(forged) }), nonce: forged });
    expect(res.status).toBe(401);
  });

  it("refuses a token minted for a different attempt's nonce", async () => {
    const mine = mintAppleNonce(SECRET);
    const theirs = mintAppleNonce(SECRET);
    const res = await signIn({ token: appleIdToken({ nonce: sha256Hex(theirs) }), nonce: mine });
    expect(res.status).toBe(401);
  });

  it("refuses a token addressed to another app", async () => {
    const nonce = mintAppleNonce(SECRET);
    const res = await signIn({
      token: appleIdToken({ nonce: sha256Hex(nonce), aud: "com.someone.else" }),
      nonce,
    });
    expect(res.status).toBe(401);
  });

  it("refuses a token not issued by Apple", async () => {
    const nonce = mintAppleNonce(SECRET);
    const res = await signIn({
      token: appleIdToken({ nonce: sha256Hex(nonce), iss: "https://evil.example" }),
      nonce,
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/auth/native/apple/nonce", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a 404 until a bundle id is configured", async () => {
    vi.stubEnv("APPLE_APP_BUNDLE_IDENTIFIER", "");
    const { GET } = await import("@/app/api/auth/native/apple/nonce/route");
    expect((await GET()).status).toBe(404);
  });

  it("mints a nonce the Apple provider will accept, uncached", async () => {
    vi.stubEnv("APPLE_APP_BUNDLE_IDENTIFIER", BUNDLE);
    const { GET } = await import("@/app/api/auth/native/apple/nonce/route");
    const { auth } = await import("@/lib/auth");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { nonce } = (await res.json()) as { nonce: string };
    expect(verifyAppleNonce(nonce, auth.options.secret as string)).toBe(true);
  });
});

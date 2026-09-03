import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { DB } from "@/db";
import { createTestUser, setupTestDb } from "@/test/helpers";
import {
  CODE_TTL_MS,
  REQUEST_TTL_MS,
  codeChallengeFor,
  consumeNativeAuthRequest,
  decryptSessionCookie,
  hashCode,
  isNativeProvider,
  issueNativeAuthCode,
  redeemNativeAuthCode,
  startNativeAuthRequest,
} from "@/lib/native-auth";

/**
 * These codes are short-lived bearer credentials for a full session
 * (docs/NATIVE_APP.md §2.3), so the tests are about what must *not* work as much
 * as what must.
 */
let db: DB;
let userId: string;

const COOKIE_NAME = "__Secure-better-auth.session_token";
const COOKIE_VALUE = "token-abc.signature-xyz";
/** The app keeps this; only its hash ever reaches the server. */
const VERIFIER = "verifier-that-never-leaves-the-app";
const CHALLENGE = codeChallengeFor(VERIFIER);

beforeEach(async () => {
  db = await setupTestDb();
  const user = await createTestUser(db);
  userId = user.id;
});

function issue(now?: Date, codeChallenge = CHALLENGE) {
  return issueNativeAuthCode({
    userId,
    sessionCookieName: COOKIE_NAME,
    sessionCookie: COOKIE_VALUE,
    codeChallenge,
    now,
  });
}

describe("issueNativeAuthCode", () => {
  it("returns the session cookie verbatim on redemption", async () => {
    const code = await issue();
    await expect(redeemNativeAuthCode(code, VERIFIER)).resolves.toEqual({
      userId,
      sessionCookieName: COOKIE_NAME,
      // Better Auth signs its session cookie, so the exchange has to reproduce
      // the exact value rather than rebuild one from the token.
      sessionCookie: COOKIE_VALUE,
    });
  });

  it("never stores the raw code", async () => {
    const code = await issue();
    const [row] = await db
      .select()
      .from(schema.nativeAuthCodes)
      .where(eq(schema.nativeAuthCodes.codeHash, hashCode(code)));

    expect(row).toBeDefined();
    expect(row.codeHash).not.toBe(code);
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it("issues high-entropy, non-repeating codes", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) codes.add(await issue());
    expect(codes.size).toBe(5);
    for (const code of codes) expect(code.length).toBeGreaterThanOrEqual(40);
  });

  it("sweeps codes that expired long enough ago to be worthless", async () => {
    const ancient = new Date(Date.now() - 10 * CODE_TTL_MS);
    await issue(ancient);
    await issue(); // triggers the sweep

    const rows = await db.select().from(schema.nativeAuthCodes);
    expect(rows).toHaveLength(1);
  });
});

describe("redeemNativeAuthCode", () => {
  it("works exactly once", async () => {
    const code = await issue();
    await expect(redeemNativeAuthCode(code, VERIFIER)).resolves.not.toBeNull();
    // A replayed code must not mint a second signed-in WebView.
    await expect(redeemNativeAuthCode(code, VERIFIER)).resolves.toBeNull();
  });

  it("refuses a code past its TTL", async () => {
    const code = await issue();
    const afterExpiry = new Date(Date.now() + CODE_TTL_MS + 1_000);
    await expect(redeemNativeAuthCode(code, VERIFIER, afterExpiry)).resolves.toBeNull();
  });

  it("refuses unknown and empty codes", async () => {
    await expect(redeemNativeAuthCode("not-a-real-code", VERIFIER)).resolves.toBeNull();
    await expect(redeemNativeAuthCode("", VERIFIER)).resolves.toBeNull();
  });

  it("lets only one of two concurrent redemptions win", async () => {
    const code = await issue();
    // The single-use check lives in the DELETE predicate precisely so this race
    // is settled by the database rather than by luck.
    const results = await Promise.all([
      redeemNativeAuthCode(code, VERIFIER),
      redeemNativeAuthCode(code, VERIFIER),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("PKCE binding", () => {
  /**
   * `whaikey://` is a scheme any app can register — on Android anyone may claim
   * it, on iOS the last installer wins — so the code on the callback has to be
   * assumed intercepted. What makes it worthless to the interceptor is the
   * verifier, which never leaves the app that started the flow (SEC-H1).
   */
  it("refuses a code redeemed with the wrong verifier", async () => {
    const code = await issue();
    await expect(redeemNativeAuthCode(code, "some-other-apps-guess")).resolves.toBeNull();
  });

  it("refuses a code redeemed with no verifier at all", async () => {
    const code = await issue();
    await expect(redeemNativeAuthCode(code, "")).resolves.toBeNull();
  });

  it("burns the code on a wrong verifier, leaving nothing to guess against", async () => {
    const code = await issue();
    await expect(redeemNativeAuthCode(code, "wrong")).resolves.toBeNull();
    // The right verifier is now too late — the row is gone, so an interceptor
    // gets one attempt, not a search.
    await expect(redeemNativeAuthCode(code, VERIFIER)).resolves.toBeNull();
    await expect(db.select().from(schema.nativeAuthCodes)).resolves.toHaveLength(0);
  });

  it("refuses a code that carries no challenge at all", async () => {
    // Rows predating PKCE, and any future path that forgets to bind one.
    const code = await issue();
    await db
      .update(schema.nativeAuthCodes)
      .set({ codeChallenge: null })
      .where(eq(schema.nativeAuthCodes.codeHash, hashCode(code)));
    await expect(redeemNativeAuthCode(code, VERIFIER)).resolves.toBeNull();
  });

  it("derives the challenge the same way the app does", () => {
    // base64url(SHA-256(verifier)) — RFC 7636 S256, no padding, URL-safe.
    expect(codeChallengeFor("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    expect(codeChallengeFor(VERIFIER)).not.toContain("=");
    expect(codeChallengeFor(VERIFIER)).not.toBe(codeChallengeFor(`${VERIFIER}!`));
  });
});

describe("session cookie at rest", () => {
  /**
   * SEC-H2: this column held a verbatim Better Auth session cookie — a
   * credential with weeks of life — in cleartext. Any read of the database
   * (a backup, a replica, a leaked pooler URL) was a set of live sessions.
   */
  it("stores no usable cookie in the table", async () => {
    await issue();
    const [row] = await db.select().from(schema.nativeAuthCodes);
    expect(row.sessionCookie).not.toBe(COOKIE_VALUE);
    expect(JSON.stringify(row)).not.toContain(COOKIE_VALUE);
    expect(JSON.stringify(row)).not.toContain("token-abc");
    // And it is genuinely reversible with the key, not just mangled.
    expect(decryptSessionCookie(row.sessionCookie)).toBe(COOKIE_VALUE);
  });

  it("uses a fresh nonce, so two codes for one session look unrelated", async () => {
    await issue();
    await issue();
    const rows = await db.select().from(schema.nativeAuthCodes);
    expect(rows[0].sessionCookie).not.toBe(rows[1].sessionCookie);
  });

  it("treats an unreadable cookie as an unredeemable code", async () => {
    const code = await issue();
    await db
      .update(schema.nativeAuthCodes)
      .set({ sessionCookie: "not.valid.ciphertext" })
      .where(eq(schema.nativeAuthCodes.codeHash, hashCode(code)));
    await expect(redeemNativeAuthCode(code, VERIFIER)).resolves.toBeNull();
    expect(decryptSessionCookie("garbage")).toBeNull();
  });

  it("leaves nothing behind once a code is redeemed", async () => {
    const code = await issue();
    await redeemNativeAuthCode(code, VERIFIER);
    // Not "marked used" — gone. A spent row is still a stored credential.
    await expect(db.select().from(schema.nativeAuthCodes)).resolves.toHaveLength(0);
  });

  it("sweeps stale codes on redeem, not only on issue", async () => {
    // The old cleanup ran inside issueNativeAuthCode alone, so a week with no
    // native sign-ins left a week of session cookies sitting readable.
    await issue(new Date(Date.now() - 10 * CODE_TTL_MS));
    await redeemNativeAuthCode("nothing-matches-this", VERIFIER);
    await expect(db.select().from(schema.nativeAuthCodes)).resolves.toHaveLength(0);
  });
});

describe("pending sign-in requests", () => {
  /**
   * Without this row, `/api/auth/native/complete` is a GET that mints a
   * session-equivalent code for anyone holding a browser session (SEC-H1).
   */
  it("round-trips the challenge, state and return path exactly once", async () => {
    const id = await startNativeAuthRequest({
      codeChallenge: CHALLENGE,
      state: "state-nonce",
      next: "/add/sasha",
    });
    await expect(consumeNativeAuthRequest(id)).resolves.toEqual({
      codeChallenge: CHALLENGE,
      state: "state-nonce",
      next: "/add/sasha",
    });
    // Single use: a replayed callback URL has nothing to complete.
    await expect(consumeNativeAuthRequest(id)).resolves.toBeNull();
  });

  it("refuses unknown, empty and expired ids", async () => {
    await expect(consumeNativeAuthRequest("never-issued")).resolves.toBeNull();
    await expect(consumeNativeAuthRequest("")).resolves.toBeNull();

    const id = await startNativeAuthRequest({ codeChallenge: CHALLENGE, state: "s" });
    const tooLate = new Date(Date.now() + REQUEST_TTL_MS + 1_000);
    await expect(consumeNativeAuthRequest(id, tooLate)).resolves.toBeNull();
  });

  it("lets only one of two concurrent completions win", async () => {
    const id = await startNativeAuthRequest({ codeChallenge: CHALLENGE, state: "s" });
    const results = await Promise.all([
      consumeNativeAuthRequest(id),
      consumeNativeAuthRequest(id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("issues unguessable ids", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add(await startNativeAuthRequest({ codeChallenge: CHALLENGE, state: "s" }));
    }
    expect(ids.size).toBe(5);
    for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(40);
  });

  it("sweeps requests abandoned mid-OAuth", async () => {
    const stale = new Date(Date.now() - 2 * REQUEST_TTL_MS);
    await startNativeAuthRequest({ codeChallenge: CHALLENGE, state: "s", now: stale });
    await startNativeAuthRequest({ codeChallenge: CHALLENGE, state: "s" });
    await expect(db.select().from(schema.nativeAuthRequests)).resolves.toHaveLength(1);
  });
});

describe("isNativeProvider", () => {
  it("accepts only the configured social providers", () => {
    expect(isNativeProvider("google")).toBe(true);
    expect(isNativeProvider("apple")).toBe(true);
    // Social login only — there is no password path to smuggle in here.
    expect(isNativeProvider("credentials")).toBe(false);
    expect(isNativeProvider("")).toBe(false);
    expect(isNativeProvider(null)).toBe(false);
  });
});

describe("safeReturnPath", () => {
  it("accepts single-leading-slash paths and rejects everything else", async () => {
    const { safeReturnPath } = await import("@/lib/native-auth");
    expect(safeReturnPath("/add/sasha")).toBe("/add/sasha");
    expect(safeReturnPath("/")).toBe("/");
    expect(safeReturnPath("//evil.example/x")).toBeNull();
    expect(safeReturnPath("/\\evil.example/x")).toBeNull(); // WHATWG parses "\" as "/"
    expect(safeReturnPath("/\t/evil.example")).toBeNull(); // WHATWG strips tabs
    expect(safeReturnPath("/\n/evil.example")).toBeNull(); // and newlines
    expect(safeReturnPath("https://evil.example/x")).toBeNull();
    expect(safeReturnPath("whaikey://auth/callback")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath("")).toBeNull();
  });
});

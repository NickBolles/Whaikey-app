import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@/db";
import type { DB } from "@/db";
import { createTestUser, setupTestDb } from "@/test/helpers";
import {
  CODE_TTL_MS,
  hashCode,
  isNativeProvider,
  issueNativeAuthCode,
  redeemNativeAuthCode,
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

beforeEach(async () => {
  db = await setupTestDb();
  const user = await createTestUser(db);
  userId = user.id;
});

function issue(now?: Date) {
  return issueNativeAuthCode({
    userId,
    sessionCookieName: COOKIE_NAME,
    sessionCookie: COOKIE_VALUE,
    now,
  });
}

describe("issueNativeAuthCode", () => {
  it("returns the session cookie verbatim on redemption", async () => {
    const code = await issue();
    await expect(redeemNativeAuthCode(code)).resolves.toEqual({
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
    await expect(redeemNativeAuthCode(code)).resolves.not.toBeNull();
    // A replayed code must not mint a second signed-in WebView.
    await expect(redeemNativeAuthCode(code)).resolves.toBeNull();
  });

  it("refuses a code past its TTL", async () => {
    const code = await issue();
    const afterExpiry = new Date(Date.now() + CODE_TTL_MS + 1_000);
    await expect(redeemNativeAuthCode(code, afterExpiry)).resolves.toBeNull();
  });

  it("refuses unknown and empty codes", async () => {
    await expect(redeemNativeAuthCode("not-a-real-code")).resolves.toBeNull();
    await expect(redeemNativeAuthCode("")).resolves.toBeNull();
  });

  it("lets only one of two concurrent redemptions win", async () => {
    const code = await issue();
    // The single-use check lives in the UPDATE predicate precisely so this race
    // is settled by the database rather than by luck.
    const results = await Promise.all([
      redeemNativeAuthCode(code),
      redeemNativeAuthCode(code),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
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
    expect(safeReturnPath("https://evil.example/x")).toBeNull();
    expect(safeReturnPath("whaikey://auth/callback")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath("")).toBeNull();
  });
});

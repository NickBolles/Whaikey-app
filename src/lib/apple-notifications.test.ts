import { generateKeyPairSync, sign as rsaSign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  APPLE_KEYS_URL,
  appleNotificationAudiences,
  appleRevocationFor,
  handleAppleNotification,
  resetAppleKeyCache,
  verifyAppleNotification,
} from "@/lib/apple-notifications";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const NOW = Date.parse("2026-10-25T12:00:00Z");

function jwk(key: KeyObject, kid: string) {
  return { ...key.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}

function makeJws(claims: Record<string, unknown>, opts: { kid?: string; key?: KeyObject; alg?: string } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = rsaSign("RSA-SHA256", Buffer.from(`${header}.${payload}`), opts.key ?? privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

function claims(events: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    iss: "https://appleid.apple.com",
    aud: "com.whaikey.app",
    iat: Math.floor(NOW / 1000) - 60,
    jti: over.jti ?? `jti-${Math.random()}`,
    events: JSON.stringify(events),
    ...over,
  };
}

/** A mocked Apple key server. */
function keyServer(keys: unknown[]) {
  return vi.fn(async (url: RequestInfo | URL) => {
    expect(String(url)).toBe(APPLE_KEYS_URL);
    return { ok: true, status: 200, json: async () => ({ keys }) } as Response;
  });
}

const audiences = ["com.whaikey.app"];

beforeEach(() => resetAppleKeyCache());

describe("verifyAppleNotification", () => {
  it("accepts a correctly signed consent-revoked notification", async () => {
    const fetchImpl = keyServer([jwk(publicKey, "k1")]);
    const n = await verifyAppleNotification(
      makeJws(claims({ type: "consent-revoked", sub: "apple-sub-1", event_time: NOW - 1000 }, { jti: "j1" })),
      { audiences, fetchImpl, now: NOW },
    );
    expect(n).toMatchObject({ jti: "j1", type: "consent-revoked", sub: "apple-sub-1" });
    expect(n.eventTime?.getTime()).toBe(NOW - 1000);
  });

  it("refuses a payload signed by any other key, even with Apple's kid", async () => {
    const fetchImpl = keyServer([jwk(publicKey, "k1")]);
    await expect(
      verifyAppleNotification(makeJws(claims({ type: "account-delete", sub: "s" }), { key: other.privateKey }), { audiences, fetchImpl, now: NOW }),
    ).rejects.toThrow(/Bad signature/);
  });

  it("refuses alg none / HS256, unknown kids, wrong issuer or audience, stale and malformed payloads", async () => {
    const fetchImpl = keyServer([jwk(publicKey, "k1")]);
    const v = (jws: unknown) => verifyAppleNotification(jws, { audiences, fetchImpl, now: NOW });
    await expect(v(makeJws(claims({ type: "account-delete", sub: "s" }), { alg: "HS256" }))).rejects.toThrow(/header/);
    await expect(v(makeJws(claims({ type: "account-delete", sub: "s" }), { kid: "nope" }))).rejects.toThrow(/Unknown signing key/);
    await expect(v(makeJws(claims({ type: "account-delete", sub: "s" }, { iss: "https://evil.example" })))).rejects.toThrow(/issuer/);
    await expect(v(makeJws(claims({ type: "account-delete", sub: "s" }, { aud: "com.other.app" })))).rejects.toThrow(/audience/);
    await expect(v(makeJws(claims({ type: "account-delete", sub: "s" }, { iat: Math.floor(NOW / 1000) - 30 * 86400 })))).rejects.toThrow(/Stale/);
    await expect(v(makeJws(claims({ type: "something-else", sub: "s" })))).rejects.toThrow(/event type/);
    await expect(v(makeJws(claims({ type: "account-delete" })))).rejects.toThrow(/sub/);
    await expect(v("not.a.jws!")).rejects.toThrow(/Malformed/);
    await expect(v(undefined)).rejects.toThrow(/Missing payload/);
  });

  it("refetches the key set once when Apple has rotated to a new kid", async () => {
    let keys = [jwk(other.publicKey, "old")];
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys }) }) as Response);
    await expect(
      verifyAppleNotification(makeJws(claims({ type: "email-disabled", sub: "s" }), { kid: "old", key: other.privateKey }), { audiences, fetchImpl, now: NOW }),
    ).resolves.toBeTruthy();
    keys = [jwk(publicKey, "new")];
    await expect(
      verifyAppleNotification(makeJws(claims({ type: "email-enabled", sub: "s" }), { kid: "new" }), { audiences, fetchImpl, now: NOW }),
    ).resolves.toMatchObject({ type: "email-enabled" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("appleNotificationAudiences", () => {
  it("is inert until Apple is configured", () => {
    expect(appleNotificationAudiences({})).toBeNull();
    expect(appleNotificationAudiences({ APPLE_APP_BUNDLE_IDENTIFIER: "com.whaikey.app" })).toEqual(["com.whaikey.app"]);
    expect(
      appleNotificationAudiences({ APPLE_APP_BUNDLE_IDENTIFIER: "com.whaikey.app", APPLE_CLIENT_ID: "com.whaikey.web", APPLE_CLIENT_SECRET: "x" }),
    ).toEqual(["com.whaikey.app", "com.whaikey.web"]);
  });
});

describe("handleAppleNotification", () => {
  let db: DB;
  let user: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db);
    await db.insert(schema.account).values({ id: uid("acct"), accountId: "apple-sub-1", providerId: "apple", userId: user.id });
    await db.insert(schema.session).values([
      { id: uid("s"), token: uid("t"), userId: user.id, expiresAt: new Date("2030-01-01T00:00:00Z") },
      { id: uid("s"), token: uid("t"), userId: user.id, expiresAt: new Date("2030-01-01T00:00:00Z") },
    ]);
  });

  it("consent revoked signs the account out everywhere and flags it, once per jti", async () => {
    const n = { jti: "j-1", type: "consent-revoked" as const, sub: "apple-sub-1", email: null, eventTime: new Date(NOW) };
    expect(await handleAppleNotification(db, n)).toEqual({ duplicate: false, userId: user.id, signedOut: true });
    expect(await db.query.session.findMany({ where: (s, { eq }) => eq(s.userId, user.id) })).toHaveLength(0);
    // The Apple link stays, so signing in again returns to the same journal.
    expect(await db.query.account.findMany({ where: (a, { eq }) => eq(a.userId, user.id) })).toHaveLength(1);
    expect(await appleRevocationFor(db, user.id)).toMatchObject({ type: "consent-revoked" });
    expect((await handleAppleNotification(db, n)).duplicate).toBe(true);
    expect(await db.query.authProviderEvents.findMany()).toHaveLength(1);
  });

  it("email relay changes are recorded without signing anyone out", async () => {
    await handleAppleNotification(db, { jti: "j-2", type: "email-disabled", sub: "apple-sub-1", email: "x@privaterelay.appleid.com", eventTime: null });
    expect(await db.query.session.findMany({ where: (s, { eq }) => eq(s.userId, user.id) })).toHaveLength(2);
    expect(await appleRevocationFor(db, user.id)).toBeNull();
  });

  it("Apple's documented account-deleted spelling signs the account out and flags it", async () => {
    const res = await handleAppleNotification(db, { jti: "j-4", type: "account-deleted", sub: "apple-sub-1", email: null, eventTime: null });
    expect(res).toEqual({ duplicate: false, userId: user.id, signedOut: true });
    expect(await db.query.session.findMany({ where: (s, { eq }) => eq(s.userId, user.id) })).toHaveLength(0);
    expect((await appleRevocationFor(db, user.id))?.type).toBe("account-deleted");
  });

  it("a subject we don't know is recorded with no account and touches nothing", async () => {
    const res = await handleAppleNotification(db, { jti: "j-3", type: "account-delete", sub: "someone-else", email: null, eventTime: null });
    expect(res).toEqual({ duplicate: false, userId: null, signedOut: false });
    expect(await db.query.session.findMany()).toHaveLength(2);
  });
});

describe("POST /api/auth/apple/notifications", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("404s until Apple is configured, then verifies and acts", async () => {
    delete process.env.APPLE_APP_BUNDLE_IDENTIFIER;
    delete process.env.APPLE_CLIENT_ID;
    delete process.env.APPLE_CLIENT_SECRET;
    await setupTestDb();
    const { POST } = await import("@/app/api/auth/apple/notifications/route");
    const req = (body: unknown) => new Request("http://localhost/api/auth/apple/notifications", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect((await POST(req({ payload: "x" }))).status).toBe(404);

    process.env.APPLE_APP_BUNDLE_IDENTIFIER = "com.whaikey.app";
    vi.stubGlobal("fetch", keyServer([jwk(publicKey, "k1")]));
    const live = claims({ type: "account-delete", sub: "apple-sub-x" }, { iat: Math.floor(Date.now() / 1000) });
    const ok = await POST(req({ payload: makeJws(live) }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, duplicate: false });
    expect((await POST(req({ payload: makeJws(live, { key: other.privateKey }) }))).status).toBe(400);
    expect((await POST(req({ nothing: true }))).status).toBe(400);
  });
});

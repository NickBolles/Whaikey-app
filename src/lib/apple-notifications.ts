import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { appleConfig } from "@/lib/apple-sign-in";

/**
 * Sign in with Apple server-to-server notifications.
 *
 * Apple POSTs `{"payload": "<JWS>"}` to the endpoint registered for the App
 * ID. The JWS is signed with one of Apple's identity keys (the same JWKS as id
 * tokens, https://appleid.apple.com/auth/keys), `iss` is
 * https://appleid.apple.com, `aud` is our client id, and the `events` claim is
 * a JSON string: `{ type, sub, email?, is_private_email?, event_time }` where
 * type is `email-disabled` | `email-enabled` | `consent-revoked` |
 * `account-deleted` (Apple's documented spelling; `account-delete`, seen in
 * older docs and samples, is kept as an alias).
 *
 * Nothing is trusted before the signature checks out against Apple's key for
 * the header's `kid`, with RS256 only. Inert until Apple is configured: with
 * no client id there is no audience to check, so the route answers 404.
 */

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
/** Notifications older than this are refused (Apple delivers within minutes; retries within hours). */
export const MAX_NOTIFICATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KEYS_TTL_MS = 60 * 60 * 1000;

export const APPLE_EVENT_TYPES = ["email-disabled", "email-enabled", "consent-revoked", "account-deleted", "account-delete"] as const;
export type AppleEventType = (typeof APPLE_EVENT_TYPES)[number];
/** Events that end the Apple link: the account is signed out and flagged. */
const SIGN_OUT_TYPES: ReadonlySet<string> = new Set(["consent-revoked", "account-deleted", "account-delete"]);

export interface AppleNotification {
  jti: string;
  type: AppleEventType;
  sub: string;
  email: string | null;
  eventTime: Date | null;
}

export class AppleNotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleNotificationError";
  }
}

type Jwk = JsonWebKey & { kid?: string; alg?: string; kty?: string };

let keyCache: { at: number; keys: Jwk[] } | null = null;

/** Test hook: forget cached Apple keys. */
export function resetAppleKeyCache(): void {
  keyCache = null;
}

async function appleKeys(fetchImpl: typeof fetch, now: number, force: boolean): Promise<Jwk[]> {
  if (!force && keyCache && now - keyCache.at < KEYS_TTL_MS) return keyCache.keys;
  const res = await fetchImpl(APPLE_KEYS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new AppleNotificationError(`Apple keys unavailable (${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  keyCache = { at: now, keys };
  return keys;
}

function b64urlJson(part: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {}
  throw new AppleNotificationError("Malformed JWS");
}

/** Verify the notification JWS and return its event. Throws AppleNotificationError on anything off. */
export async function verifyAppleNotification(
  jws: unknown,
  opts: { audiences: string[]; fetchImpl?: typeof fetch; now?: number },
): Promise<AppleNotification> {
  if (typeof jws !== "string" || jws.length > 16_384) throw new AppleNotificationError("Missing payload");
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new AppleNotificationError("Malformed JWS");
  const [h, p, sig] = parts;
  const header = b64urlJson(h);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AppleNotificationError("Unexpected JWS header");

  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  let jwk = (await appleKeys(fetchImpl, now, false)).find((k) => k.kid === header.kid);
  // Apple rotates keys: an unknown kid earns one fresh fetch, not a refusal.
  if (!jwk) jwk = (await appleKeys(fetchImpl, now, true)).find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== "RSA") throw new AppleNotificationError("Unknown signing key");

  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok = verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig, "base64url"));
  if (!ok) throw new AppleNotificationError("Bad signature");

  const claims = b64urlJson(p);
  if (claims.iss !== APPLE_ISSUER) throw new AppleNotificationError("Wrong issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === "string" && opts.audiences.includes(a))) throw new AppleNotificationError("Wrong audience");
  const iat = typeof claims.iat === "number" ? claims.iat * 1000 : NaN;
  if (!Number.isFinite(iat) || iat > now + 5 * 60_000 || now - iat > MAX_NOTIFICATION_AGE_MS) {
    throw new AppleNotificationError("Stale or future notification");
  }
  if (typeof claims.jti !== "string" || claims.jti.length === 0 || claims.jti.length > 200) throw new AppleNotificationError("Missing jti");

  let events: Record<string, unknown>;
  try {
    events = typeof claims.events === "string" ? JSON.parse(claims.events) : (claims.events as Record<string, unknown>);
  } catch {
    throw new AppleNotificationError("Malformed events");
  }
  if (!events || typeof events !== "object") throw new AppleNotificationError("Malformed events");
  const type = events.type;
  if (typeof type !== "string" || !(APPLE_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new AppleNotificationError("Unknown event type");
  }
  if (typeof events.sub !== "string" || events.sub.length === 0) throw new AppleNotificationError("Missing sub");
  const eventTimeRaw = events.event_time;
  const eventTime =
    typeof eventTimeRaw === "number" ? new Date(eventTimeRaw > 1e12 ? eventTimeRaw : eventTimeRaw * 1000) : null;
  return {
    jti: claims.jti,
    type: type as AppleEventType,
    sub: events.sub,
    email: typeof events.email === "string" ? events.email : null,
    eventTime: eventTime && !Number.isNaN(eventTime.getTime()) ? eventTime : null,
  };
}

/** The audiences a notification may be addressed to, or null when Apple is not configured. */
export function appleNotificationAudiences(env: Record<string, string | undefined> = process.env): string[] | null {
  const config = appleConfig(env);
  if (!config) return null;
  const audiences = [config.bundleId, config.servicesId].filter((v): v is string => Boolean(v));
  return audiences.length > 0 ? audiences : null;
}

export interface HandledNotification {
  duplicate: boolean;
  userId: string | null;
  signedOut: boolean;
}

/**
 * Record the event once (by `jti`) and act on it. Revocation and Apple ID
 * deletion sign the account out everywhere — every session row goes — and
 * the recorded event is the account's flag. The Apple link itself is kept:
 * deleting it would let the next Sign in with Apple mint a second, empty
 * account for the same person instead of returning them to their journal.
 */
export async function handleAppleNotification(db: DB, n: AppleNotification): Promise<HandledNotification> {
  return db.transaction(async (tx) => {
    const linked = await tx.query.account.findFirst({
      columns: { userId: true },
      where: and(eq(schema.account.providerId, "apple"), eq(schema.account.accountId, n.sub)),
    });
    const userId = linked?.userId ?? null;
    const inserted = await tx
      .insert(schema.authProviderEvents)
      .values({
        id: crypto.randomUUID(),
        jti: n.jti,
        providerId: "apple",
        providerAccountId: n.sub,
        userId,
        eventType: n.type,
        eventTime: n.eventTime,
      })
      .onConflictDoNothing({ target: schema.authProviderEvents.jti })
      .returning({ id: schema.authProviderEvents.id });
    if (inserted.length === 0) return { duplicate: true, userId, signedOut: false };

    let signedOut = false;
    if (userId && SIGN_OUT_TYPES.has(n.type)) {
      await tx.delete(schema.session).where(eq(schema.session.userId, userId));
      signedOut = true;
    }
    return { duplicate: false, userId, signedOut };
  });
}

/** The latest revocation/deletion Apple reported for this account, if any (the account flag). */
export async function appleRevocationFor(db: DB, userId: string): Promise<{ type: string; at: Date } | null> {
  const rows = await db
    .select({ type: schema.authProviderEvents.eventType, at: schema.authProviderEvents.receivedAt })
    .from(schema.authProviderEvents)
    .where(and(eq(schema.authProviderEvents.userId, userId), eq(schema.authProviderEvents.providerId, "apple")));
  const flagged = rows
    .filter((r) => SIGN_OUT_TYPES.has(r.type))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  return flagged[0] ?? null;
}

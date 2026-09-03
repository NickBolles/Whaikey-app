import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * Handing a signed-in session from the system browser into the app's WebView
 * (docs/NATIVE_APP.md §2.3).
 *
 * Google rejects OAuth in embedded WebViews, so the native app opens sign-in in
 * the real browser. That browser's cookie jar is not the WebView's, so the app
 * comes back with a one-time code and redeems it *inside* the WebView, where the
 * `Set-Cookie` lands in the right store.
 *
 * The code is a bearer credential for a full session, so it is treated like one:
 * 32 bytes of entropy, 60-second lifetime, redeemable exactly once, stored only
 * as a hash, and destroyed on redemption.
 *
 * Holding the code is not enough to redeem it. `whaikey://` is a custom scheme
 * anyone can register — on Android any app may claim it, on iOS the last
 * installer wins — so the code is bound with PKCE to a verifier that never
 * leaves the app that started the flow (SEC-H1). A code intercepted by another
 * app redeems to nothing.
 */

/** Long enough that guessing is hopeless inside the 60s window. */
const CODE_BYTES = 32;
export const CODE_TTL_MS = 60_000;

/**
 * How long a started sign-in stays redeemable. Long enough for a real OAuth
 * round trip — consent, a first-time account, a password manager, an app switch
 * — and no longer, because the row is what makes a callback legitimate.
 */
export const REQUEST_TTL_MS = 10 * 60_000;

/** The scheme registered in Info.plist and AndroidManifest.xml. */
export const NATIVE_CALLBACK_SCHEME = "whaikey";

// Shared with the client-side sign-in page — the validation itself lives in
// the dependency-free return-path module; re-exported here so server callers
// keep their import path.
export { safeReturnPath } from "@/lib/return-path";

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// --- PKCE -------------------------------------------------------------------

/**
 * The S256 challenge for a verifier: base64url(SHA-256(verifier)).
 *
 * Shared by the app (which computes it from the verifier it keeps) and the
 * server (which recomputes it at redemption), so there is one definition of the
 * transform and no chance of the two drifting.
 */
export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// --- session cookie encryption ----------------------------------------------

/**
 * These rows hold a verbatim Better Auth session cookie — a credential with
 * weeks of life — for the sixty seconds between OAuth finishing and the app
 * redeeming it (SEC-H2). Sixty seconds is long enough to end up in a backup, a
 * replica, or a leaked pooler URL, so the column holds ciphertext and the key
 * stays in the environment.
 *
 * Keyed off BETTER_AUTH_SECRET, which production already refuses to boot
 * without (`src/lib/auth.ts`). Rotating it is harmless here: the ciphertext it
 * protects is worthless within the minute, so an unreadable row costs one
 * retried sign-in and nothing else.
 */
function cookieKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me";
  return createHash("sha256").update(`native-auth-cookie:${secret}`).digest();
}

/** `iv.ciphertext.tag`, all base64url — self-describing, no separate columns. */
export function encryptSessionCookie(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cookieKey(), iv);
  const enciphered = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    enciphered.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

/** Null for anything that doesn't decrypt — a wrong key reads as an expired code. */
export function decryptSessionCookie(stored: string): string | null {
  const parts = stored.split(".");
  if (parts.length !== 3) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cookieKey(),
      Buffer.from(parts[0], "base64url"),
    );
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[1], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

// --- pending sign-ins -------------------------------------------------------

export interface NativeAuthRequestInit {
  codeChallenge: string;
  state: string;
  next?: string | null;
  now?: Date;
}

/**
 * Record a sign-in the app actually started, and return the id that has to come
 * back for it to be completed.
 *
 * This is what stops `/complete` being a URL that mints a session-equivalent
 * code for whoever happens to hold a browser session (SEC-H1). The id rides the
 * OAuth round trip in the callback URL, exactly as a `state` parameter would.
 */
export async function startNativeAuthRequest(params: NativeAuthRequestInit): Promise<string> {
  const now = params.now ?? new Date();
  const id = randomBytes(CODE_BYTES).toString("base64url");
  const db = getDb();

  await db.insert(schema.nativeAuthRequests).values({
    id,
    codeChallenge: params.codeChallenge,
    state: params.state,
    next: params.next ?? null,
    expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
  });

  await db
    .delete(schema.nativeAuthRequests)
    .where(lt(schema.nativeAuthRequests.expiresAt, now));

  return id;
}

export interface ConsumedAuthRequest {
  codeChallenge: string;
  state: string;
  next: string | null;
  /**
   * The request was real but took too long. The app still needs its state back
   * to recognise the callback as its own — without it the callback is dropped
   * as forged and sign-in hangs on "Connecting…" until the user restarts, so
   * an expired request is reported, not silently discarded.
   */
  expired: boolean;
}

/**
 * Take a pending sign-in, or null if it is unknown or already used.
 *
 * `DELETE … RETURNING` so two callbacks for one request race in the database
 * and exactly one wins, and so nothing is left behind to replay. Expiry is
 * judged after the delete rather than in its predicate: an expired row is
 * still this app's row, and telling it so is what lets it fail cleanly. Null
 * is reserved for an id nobody issued — the forged case, which gets nothing.
 */
export async function consumeNativeAuthRequest(
  id: string,
  now: Date = new Date(),
): Promise<ConsumedAuthRequest | null> {
  if (!id) return null;
  const [row] = await getDb()
    .delete(schema.nativeAuthRequests)
    .where(eq(schema.nativeAuthRequests.id, id))
    .returning();
  if (!row) return null;
  return {
    codeChallenge: row.codeChallenge,
    state: row.state,
    next: row.next,
    expired: row.expiresAt.getTime() <= now.getTime(),
  };
}

/**
 * Delete every code that is past being useful.
 *
 * Runs on issue *and* on redeem (SEC-H2): cleanup that only happened on issue
 * meant a week with no native sign-ins left a week's worth of session cookies
 * sitting in the table, which is precisely when nobody is looking.
 */
async function sweepExpiredCodes(now: Date): Promise<void> {
  await getDb()
    .delete(schema.nativeAuthCodes)
    .where(lt(schema.nativeAuthCodes.expiresAt, new Date(now.getTime() - CODE_TTL_MS)));
}

/**
 * Mint a code that redeems to `sessionCookie`.
 *
 * The raw cookie value is what gets encrypted and stored, rather than the bare
 * session token: Better Auth signs its session cookie, so reproducing the exact
 * value is what makes the WebView's session valid, and it avoids minting a
 * second session row that would then need its own revocation story.
 *
 * `codeChallenge` comes from the pending request the app started, and binds the
 * code to the verifier only that app holds.
 */
export async function issueNativeAuthCode(params: {
  userId: string;
  sessionCookieName: string;
  sessionCookie: string;
  codeChallenge: string;
  now?: Date;
}): Promise<string> {
  const now = params.now ?? new Date();
  const code = randomBytes(CODE_BYTES).toString("base64url");
  const db = getDb();

  await db.insert(schema.nativeAuthCodes).values({
    id: crypto.randomUUID(),
    codeHash: hashCode(code),
    userId: params.userId,
    sessionCookieName: params.sessionCookieName,
    sessionCookie: encryptSessionCookie(params.sessionCookie),
    codeChallenge: params.codeChallenge,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
  });

  await sweepExpiredCodes(now);

  return code;
}

export interface RedeemedSession {
  userId: string;
  sessionCookieName: string;
  sessionCookie: string;
}

/**
 * Redeem a code, or return null if it is unknown, expired, already used, or the
 * verifier doesn't match the challenge it was minted against.
 *
 * `DELETE … RETURNING` rather than a used-at flag (SEC-H2): the delete is
 * atomic, so two concurrent redemptions race in the database and exactly one
 * wins — a read-then-write would let both through — and it destroys the secret
 * instead of leaving it in a row marked "spent". Because the row is gone either
 * way, a wrong verifier burns the code; there is nothing to guess against.
 */
export async function redeemNativeAuthCode(
  code: string,
  verifier: string,
  now: Date = new Date(),
): Promise<RedeemedSession | null> {
  if (!code || !verifier) return null;
  const db = getDb();

  const [row] = await db
    .delete(schema.nativeAuthCodes)
    .where(
      and(
        eq(schema.nativeAuthCodes.codeHash, hashCode(code)),
        sql`${schema.nativeAuthCodes.expiresAt} > ${now}`,
      ),
    )
    .returning();

  // Leftover rows are the risk this whole design is about, so take the chance
  // to clear anything stale whether or not this redemption found its code.
  await sweepExpiredCodes(now);

  if (!row) return null;
  // A code minted before PKCE existed has no challenge and is not redeemable.
  if (!row.codeChallenge) return null;
  if (!safeEqual(codeChallengeFor(verifier), row.codeChallenge)) return null;

  const sessionCookie = decryptSessionCookie(row.sessionCookie);
  if (sessionCookie === null) return null;

  return {
    userId: row.userId,
    sessionCookieName: row.sessionCookieName,
    sessionCookie,
  };
}

/**
 * Constant-time compare for anything derived from user input that gates access.
 * Not used on the code itself (the database lookup is already exact-match on a
 * hash); it is what compares the PKCE challenge at redemption.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Providers the native sign-in flow will start. */
export const NATIVE_PROVIDERS = ["google", "apple"] as const;
export type NativeProvider = (typeof NATIVE_PROVIDERS)[number];

export function isNativeProvider(value: string | null): value is NativeProvider {
  return value !== null && (NATIVE_PROVIDERS as readonly string[]).includes(value);
}

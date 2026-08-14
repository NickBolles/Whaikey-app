import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
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
 * 32 bytes of entropy, 60-second lifetime, redeemable exactly once, and stored
 * only as a hash.
 */

/** Long enough that guessing is hopeless inside the 60s window. */
const CODE_BYTES = 32;
export const CODE_TTL_MS = 60_000;

/** The scheme registered in Info.plist and AndroidManifest.xml. */
export const NATIVE_CALLBACK_SCHEME = "whaikey";

/**
 * The only return target the native sign-in flow will honor: a same-origin
 * relative path with a single leading slash. Anything else — absolute URLs,
 * protocol-relative "//host", or backslash variants like "/\evil.example"
 * (WHATWG URL parsing treats "\" as "/") — would turn the exchange redirect
 * into an open redirect and collapses to null (callers fall back to "/").
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || !/^\/(?!\/)/.test(raw) || raw.includes("\\")) return null;
  // WHATWG URL parsing strips tab/CR/LF anywhere in the input, so
  // "/\t/evil.example" would collapse to protocol-relative "//evil.example".
  // Reject every C0 control character (and DEL) outright.
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  return raw;
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * Mint a code that redeems to `sessionCookie`.
 *
 * The raw cookie value is stored verbatim rather than the bare session token:
 * Better Auth signs its session cookie, so reproducing the exact value is what
 * makes the WebView's session valid, and it avoids minting a second session row
 * that would then need its own revocation story.
 */
export async function issueNativeAuthCode(params: {
  userId: string;
  sessionCookieName: string;
  sessionCookie: string;
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
    sessionCookie: params.sessionCookie,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
  });

  // Opportunistic cleanup: these rows are worthless within a minute, and this
  // keeps the table from growing without a scheduled job.
  await db
    .delete(schema.nativeAuthCodes)
    .where(lt(schema.nativeAuthCodes.expiresAt, new Date(now.getTime() - CODE_TTL_MS)));

  return code;
}

export interface RedeemedSession {
  userId: string;
  sessionCookieName: string;
  sessionCookie: string;
}

/**
 * Redeem a code, or return null if it is unknown, expired, or already used.
 *
 * The `usedAt IS NULL` predicate lives in the UPDATE itself, so two concurrent
 * redemptions of the same code race in the database and exactly one wins — a
 * read-then-write would let both through.
 */
export async function redeemNativeAuthCode(
  code: string,
  now: Date = new Date(),
): Promise<RedeemedSession | null> {
  if (!code) return null;
  const db = getDb();

  const [row] = await db
    .update(schema.nativeAuthCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(schema.nativeAuthCodes.codeHash, hashCode(code)),
        isNull(schema.nativeAuthCodes.usedAt),
        sql`${schema.nativeAuthCodes.expiresAt} > ${now}`,
      ),
    )
    .returning();

  if (!row) return null;
  return {
    userId: row.userId,
    sessionCookieName: row.sessionCookieName,
    sessionCookie: row.sessionCookie,
  };
}

/**
 * Constant-time compare for anything derived from user input that gates access.
 * Not used on the code itself (the database lookup is already exact-match on a
 * hash), but kept here for the state parameter checks.
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

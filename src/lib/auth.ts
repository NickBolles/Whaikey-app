import { isNotNull, lt, or } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb, schema } from "@/db";
import type { DB } from "@/db";

/**
 * Social login only (PLAN.md §2.1 / user decision): no email+password.
 * Providers activate when their env vars are present, so local dev without
 * OAuth credentials still boots (the sign-in page explains setup).
 */
function socialProviders() {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET) {
    providers.apple = {
      clientId: process.env.APPLE_CLIENT_ID,
      clientSecret: process.env.APPLE_CLIENT_SECRET,
    };
  }
  return providers;
}

/**
 * Canonical base URL for OAuth callbacks. In production set BETTER_AUTH_URL to
 * the app's public URL; on Vercel preview deploys we fall back to the per-deploy
 * VERCEL_URL so the server still boots (OAuth callbacks require BETTER_AUTH_URL
 * to match a registered redirect URI, so sign-in itself is a production flow).
 */
function baseURL(): string {
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/**
 * Origins Better Auth accepts requests from (in addition to baseURL). On Vercel
 * the app is reachable at several of its own hostnames — the per-deploy URL, the
 * branch alias, and the stable production URL — so trust each that's present.
 * These are the project's own deployment URLs (not a broad `*.vercel.app`), so
 * a deploy or preview link stops throwing "Invalid origin" at sign-in.
 */
function trustedOrigins(): string[] {
  return [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]
    .filter((host): host is string => Boolean(host))
    .map((host) => `https://${host}`);
}

function authSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  // Never silently sign production sessions with a public development value.
  // Build evaluation intentionally remains possible without deployment secrets.
  if (!secret && process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    throw new Error("BETTER_AUTH_SECRET must be configured in production");
  }
  return secret ?? "dev-only-secret-change-me";
}

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: "pg", schema }),
  secret: authSecret(),
  baseURL: baseURL(),
  trustedOrigins: trustedOrigins(),
  socialProviders: socialProviders(),
  emailAndPassword: { enabled: false },
  /**
   * Better Auth's `account` table keeps the provider's access, refresh and id
   * tokens. Whaikey never calls Google or Apple on a user's behalf — the
   * providers are an identity source and nothing else — but the rows exist
   * because the adapter writes them, so they are encrypted at rest with
   * `BETTER_AUTH_SECRET` rather than sitting in plaintext beside the journal.
   *
   * `/privacy` names them, their purpose and their retention. It used to say
   * "we never see a credential" and list only the name, email and avatar,
   * which was a data inventory missing its most sensitive row.
   */
  account: { encryptOAuthTokens: true },
});

export type Session = typeof auth.$Infer.Session;

/**
 * Delete sessions whose expiry has passed.
 *
 * Better Auth stops honouring an expired session, but nothing removes the row —
 * so a device that simply stops making requests leaves its bearer token, IP
 * address and user agent behind indefinitely. `/privacy` says those go when the
 * session expires, and that sentence was written one commit before this
 * function existed: expiry made the token useless, not absent, and the page
 * promised absence.
 *
 * `getSessionUser` never reads an expired row, so nothing is signed out by
 * this that was not already signed out.
 */
export async function sweepExpiredSessions(db: DB, now = new Date()): Promise<void> {
  await db.delete(schema.session).where(lt(schema.session.expiresAt, now));
}

/**
 * Clear provider tokens, every run, for everybody.
 *
 * Migration 0032 empties the ones written before `encryptOAuthTokens` — but
 * `scripts/build.mjs` applies migrations **before** the build that activates
 * the new code, so the previous deployment is still serving during that
 * window and any sign-in in it writes fresh plaintext *after* the one-time
 * `UPDATE` has run. A migration does not run twice, so those would have stayed
 * plaintext forever while `/privacy` says the tokens are encrypted at rest.
 *
 * Rather than detect plaintext — Better Auth's own test for it is a heuristic
 * over hex strings, and guessing wrong about a credential is not a thing to
 * build on — this clears the columns unconditionally. Nothing reads them:
 * Whaikey never calls Google or Apple on a user's behalf, which is the same
 * fact `/privacy` gives as the reason they exist at all. So the strongest
 * true statement is that they do not persist, and the rollout window closes
 * within a day instead of never.
 */
export async function sweepProviderTokens(db: DB): Promise<void> {
  await db
    .update(schema.account)
    .set({
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    })
    .where(
      or(
        isNotNull(schema.account.accessToken),
        isNotNull(schema.account.refreshToken),
        isNotNull(schema.account.idToken),
      ),
    );
}

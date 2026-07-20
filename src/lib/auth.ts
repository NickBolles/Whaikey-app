import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb, schema } from "@/db";

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

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: "pg", schema }),
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me",
  baseURL: baseURL(),
  trustedOrigins: trustedOrigins(),
  socialProviders: socialProviders(),
  emailAndPassword: { enabled: false },
});

export type Session = typeof auth.$Infer.Session;

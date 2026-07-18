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

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: "pg", schema }),
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me",
  baseURL: baseURL(),
  socialProviders: socialProviders(),
  emailAndPassword: { enabled: false },
});

export type Session = typeof auth.$Infer.Session;

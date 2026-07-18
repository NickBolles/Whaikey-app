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

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), { provider: "sqlite", schema }),
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-only-secret-change-me",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  socialProviders: socialProviders(),
  emailAndPassword: { enabled: false },
});

export type Session = typeof auth.$Infer.Session;

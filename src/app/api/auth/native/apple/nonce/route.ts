import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isNativeAppleConfigured, mintAppleNonce } from "@/lib/apple-sign-in";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/native/apple/nonce — the nonce for one native Sign in with
 * Apple attempt (src/lib/apple-sign-in.ts).
 *
 * The device hashes it into the `ASAuthorizationAppleIDRequest`, then posts the
 * raw value back with the id token to `/api/auth/sign-in/social`, where the
 * Apple provider refuses any nonce this endpoint did not mint recently.
 *
 * 404 when no bundle id is configured: the native path cannot succeed without
 * one, and the app reads the 404 as "fall back to the browser flow". Public
 * on purpose — a nonce is not a credential, only a freshness token.
 */
export async function GET() {
  if (!isNativeAppleConfigured()) {
    return NextResponse.json({ error: "Sign in with Apple is not configured" }, { status: 404 });
  }
  return NextResponse.json(
    { nonce: mintAppleNonce(auth.options.secret as string) },
    { headers: { "cache-control": "no-store" } },
  );
}

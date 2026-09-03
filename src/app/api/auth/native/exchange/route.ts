import { NextRequest, NextResponse } from "next/server";
import { redeemNativeAuthCode, safeReturnPath } from "@/lib/native-auth";

/**
 * Step 3 of native sign-in (docs/NATIVE_APP.md §2.3).
 *
 * The app navigates its **WebView** here after the custom-scheme callback wakes
 * it. Because the navigation happens inside the WebView, the `Set-Cookie` on this
 * response lands in the WebView's cookie store — which is the entire point of the
 * dance. From here on the native app is just the web app, signed in, with
 * ordinary first-party cookie auth.
 *
 * The redirect is always same-origin: either "/" or a safeReturnPath-validated
 * relative path (a scanned /add/<handle> code that should survive sign-in), so a
 * code replayed from elsewhere gains nothing beyond what redeeming it already
 * would, and the `next` param can never leave the origin.
 *
 * The `code_verifier` is what makes the code worth anything (SEC-H1). Only the
 * app that started this sign-in has it, so an app that claimed `whaikey://` and
 * grabbed the code off the callback holds something that redeems to nothing.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") ?? "";
  const verifier = request.nextUrl.searchParams.get("code_verifier") ?? "";
  const next = safeReturnPath(request.nextUrl.searchParams.get("next")) ?? "/";
  const redeemed = await redeemNativeAuthCode(code, verifier);

  if (!redeemed) {
    // Unknown, expired, already redeemed, or verifier mismatch — all
    // indistinguishable on purpose, and all having destroyed the code.
    // `next` rides along so retrying sign-in still lands on the scanned target
    // instead of making the person scan again.
    const retry = new URL("/sign-in?error=expired", request.nextUrl.origin);
    if (next !== "/") retry.searchParams.set("next", next);
    return NextResponse.redirect(retry);
  }

  // Belt and braces on top of safeReturnPath: resolve the candidate against
  // our origin and verify it stayed there. Whatever future parser quirk slips
  // past the string checks, a redirect can never leave this origin.
  let target = new URL("/", request.nextUrl.origin);
  try {
    const resolved = new URL(next, request.nextUrl.origin);
    if (resolved.origin === request.nextUrl.origin) target = resolved;
  } catch {
    // Unparseable → fall back to "/".
  }
  const response = NextResponse.redirect(target);
  response.cookies.set({
    name: redeemed.sessionCookieName,
    value: redeemed.sessionCookie,
    httpOnly: true,
    // The WebView is on https://<app host>, so the cookie's own attributes match
    // what Better Auth would have set on a browser sign-in.
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
  });
  return response;
}

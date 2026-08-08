import { NextRequest, NextResponse } from "next/server";
import { redeemNativeAuthCode } from "@/lib/native-auth";

/**
 * Step 3 of native sign-in (docs/NATIVE_APP.md §2.3).
 *
 * The app navigates its **WebView** here after the custom-scheme callback wakes
 * it. Because the navigation happens inside the WebView, the `Set-Cookie` on this
 * response lands in the WebView's cookie store — which is the entire point of the
 * dance. From here on the native app is just the web app, signed in, with
 * ordinary first-party cookie auth.
 *
 * The redirect is always same-origin and always a fixed path, so a code replayed
 * from elsewhere gains nothing beyond what redeeming it already would.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") ?? "";
  const redeemed = await redeemNativeAuthCode(code);

  if (!redeemed) {
    // Unknown, expired, or already redeemed — all indistinguishable on purpose.
    return NextResponse.redirect(new URL("/sign-in?error=expired", request.nextUrl.origin));
  }

  const response = NextResponse.redirect(new URL("/", request.nextUrl.origin));
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

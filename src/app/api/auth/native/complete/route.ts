import { NextRequest, NextResponse } from "next/server";
import { issueNativeAuthCode, NATIVE_CALLBACK_SCHEME, safeReturnPath } from "@/lib/native-auth";
import { getSessionUser } from "@/lib/session";

/**
 * Step 2 of native sign-in (docs/NATIVE_APP.md §2.3).
 *
 * OAuth has finished, so the **system browser** now holds a valid session
 * cookie. The app's WebView does not. This handler packages that session behind
 * a one-time code and bounces to the custom scheme, which wakes the app.
 *
 * The code — not the cookie — travels through the URL: a custom-scheme redirect
 * is visible to anything that can observe the browser's navigation, and a code
 * that dies in 60 seconds and works once is a far smaller thing to leak than a
 * session cookie with weeks of life in it.
 */
export const dynamic = "force-dynamic";

function appRedirect(params: Record<string, string>): NextResponse {
  const url = new URL(`${NATIVE_CALLBACK_SCHEME}://auth/callback`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // NextResponse.redirect refuses non-HTTP schemes, so build the 302 by hand.
  return new NextResponse(null, { status: 302, headers: { location: url.toString() } });
}

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    // OAuth was cancelled or the callback failed — tell the app so it can show a
    // real message rather than hanging on a browser that silently closed.
    return appRedirect({ error: "not_signed_in" });
  }

  const { auth } = await import("@/lib/auth");
  const { getCookies } = await import("better-auth/cookies");
  // Ask Better Auth for its own cookie name rather than guessing: the name gains
  // a __Secure- prefix in production, and hardcoding it would break there only.
  const cookieName = getCookies(auth.options).sessionToken.name;
  const sessionCookie = request.cookies.get(cookieName)?.value;

  if (!sessionCookie) {
    console.error("[native-auth] signed in but no session cookie named", cookieName);
    return appRedirect({ error: "no_session_cookie" });
  }

  try {
    const code = await issueNativeAuthCode({
      userId: user.id,
      sessionCookieName: cookieName,
      sessionCookie,
    });
    const next = safeReturnPath(request.nextUrl.searchParams.get("next"));
    return appRedirect(next ? { code, next } : { code });
  } catch (err) {
    console.error("[native-auth] failed to issue exchange code", err);
    return appRedirect({ error: "exchange_failed" });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { reportingErrors } from "@/lib/observability/errors";
import {
  consumeNativeAuthRequest,
  issueNativeAuthCode,
  NATIVE_CALLBACK_SCHEME,
} from "@/lib/native-auth";
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
 * that dies in 60 seconds, works once, and needs a verifier the app kept to
 * itself is a far smaller thing to leak than a session cookie with weeks of
 * life in it.
 *
 * Nothing is minted without a live `request` id from `/start` (SEC-H1). A GET
 * that arrives with a browser session and no pending sign-in is not a sign-in
 * this app asked for, and it leaves here with no code.
 */
export const dynamic = "force-dynamic";

function appRedirect(params: Record<string, string>): NextResponse {
  const url = new URL(`${NATIVE_CALLBACK_SCHEME}://auth/callback`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // NextResponse.redirect refuses non-HTTP schemes, so build the 302 by hand.
  return new NextResponse(null, { status: 302, headers: { location: url.toString() } });
}

async function handleGet(request: NextRequest) {
  // Single-use: consumed here whatever the outcome, so a callback URL that
  // leaks (browser history, a shared screen) can't be walked back through.
  const pending = await consumeNativeAuthRequest(
    request.nextUrl.searchParams.get("request") ?? "",
  );

  if (!pending) {
    // An id nobody issued, or one already answered. There is nothing to echo a
    // state back to, so the app has nothing to accept — which is the point:
    // this response is inert.
    return appRedirect({ error: "no_request" });
  }

  // The state the app is waiting to see, and the return path it asked for, both
  // read from the row rather than the URL — neither can be rewritten in flight.
  const { state, next } = pending;
  const withState = (params: Record<string, string>) =>
    appRedirect(next ? { ...params, state, next } : { ...params, state });

  if (pending.expired) {
    // A real sign-in that took longer than the TTL. It gets its state back so
    // the app recognises the callback as its own and can close the browser,
    // clear the pending sign-in and say so — a stateless answer would be
    // dropped as forged and leave sign-in hanging on "Connecting…".
    return withState({ error: "expired" });
  }

  const user = await getSessionUser();
  if (!user) {
    // OAuth was cancelled or the callback failed — tell the app so it can show a
    // real message rather than hanging on a browser that silently closed.
    return withState({ error: "not_signed_in" });
  }

  const { auth } = await import("@/lib/auth");
  const { getCookies } = await import("better-auth/cookies");
  // Ask Better Auth for its own cookie name rather than guessing: the name gains
  // a __Secure- prefix in production, and hardcoding it would break there only.
  const cookieName = getCookies(auth.options).sessionToken.name;
  const sessionCookie = request.cookies.get(cookieName)?.value;

  if (!sessionCookie) {
    console.error("[native-auth] signed in but no session cookie named", cookieName);
    return withState({ error: "no_session_cookie" });
  }

  try {
    const code = await issueNativeAuthCode({
      userId: user.id,
      sessionCookieName: cookieName,
      sessionCookie,
      codeChallenge: pending.codeChallenge,
    });
    return withState({ code });
  } catch (err) {
    console.error("[native-auth] failed to issue exchange code", err);
    return withState({ error: "exchange_failed" });
  }
}

/**
 * Reporting only (WP-19). This route does not use `withErrorHandling` — it
 * owns its own responses for reasons documented above — so the wrapper adds
 * the Sentry report and nothing else: same error, same response, same status.
 */
export async function GET(request: NextRequest) {
  return reportingErrors("auth/native/complete", () => handleGet(request));
}

import { NextRequest, NextResponse } from "next/server";
import { reportInBackground, reportingErrors } from "@/lib/observability/errors";
import { isNativeProvider, safeReturnPath, startNativeAuthRequest } from "@/lib/native-auth";

/**
 * Step 1 of native sign-in (docs/NATIVE_APP.md §2.3).
 *
 * The app opens this URL in the **system browser**, not its own WebView, because
 * Google refuses OAuth from embedded WebViews (`disallowed_useragent`). This
 * handler records what the app is asking for — its PKCE challenge and its state
 * nonce — and kicks off the normal Better Auth social flow with a callback to
 * `/api/auth/native/complete`, carrying the id of that record.
 *
 * The record is the thing that makes the callback legitimate. Without it,
 * `/complete` is a URL that hands a session-equivalent code to whoever holds a
 * browser session, which is half of SEC-H1.
 */
export const dynamic = "force-dynamic";

/**
 * Both values are opaque to us — we only ever compare them to themselves — so
 * this is a sanity floor, not a format: enough entropy to be worth binding to,
 * and short enough not to be a way to write arbitrary data into the table.
 */
function isChallenge(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9._~-]{32,128}$/.test(value);
}

async function handleGet(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get("provider");
  if (!isNativeProvider(provider)) {
    return NextResponse.json(
      { error: "Unsupported provider", details: "Expected google or apple." },
      { status: 400 },
    );
  }

  // PKCE (S256) and the state nonce, both minted by the app. The verifier stays
  // on the device; only its hash comes through here, so nothing observable on
  // this request is enough to redeem the code the flow ends in.
  const codeChallenge = request.nextUrl.searchParams.get("code_challenge");
  const state = request.nextUrl.searchParams.get("state");
  if (!isChallenge(codeChallenge) || !isChallenge(state)) {
    return NextResponse.json(
      {
        error: "Invalid sign-in request",
        details: "code_challenge and state are required (PKCE S256).",
      },
      { status: 400 },
    );
  }

  const { auth } = await import("@/lib/auth");
  // Optional validated return path (e.g. a scanned /add/<handle> code) that
  // rides the whole flow so the app can land back where the user started. It is
  // parked on the pending row rather than the URL, so the round trip can't
  // rewrite where sign-in lands.
  const next = safeReturnPath(request.nextUrl.searchParams.get("next"));

  try {
    const pending = await startNativeAuthRequest({ codeChallenge, state, next });
    const { url } = await auth.api.signInSocial({
      body: {
        provider,
        // Relative to the auth baseURL. After OAuth resolves, the browser lands
        // here already carrying the session cookie.
        callbackURL: `/api/auth/native/complete?request=${encodeURIComponent(pending)}`,
        // Sign-in must not silently become sign-up-less: a first-time native
        // user should get an account exactly as they would on the web.
        disableRedirect: true,
      },
      headers: request.headers,
    });

    if (!url) {
      return NextResponse.json({ error: "Provider is not configured" }, { status: 503 });
    }
    return NextResponse.redirect(url);
  } catch (err) {
    console.error("[native-auth] failed to start social sign-in", err);
    /**
     * Reported here, not by the wrapper.
     *
     * `reportingErrors` only sees what escapes, and this catch answers 503
     * instead of rethrowing — so wrapping the handler bought this route
     * nothing at all: the one failure it actually has (the provider or the
     * pending-request write breaking) was swallowed on the way past. A native
     * sign-in that stops working is invisible from the server side otherwise,
     * because every device just shows "Sign-in unavailable" and gives up.
     */
    reportInBackground(err, { where: "auth/native/start" });
    return NextResponse.json({ error: "Sign-in unavailable" }, { status: 503 });
  }
}

/**
 * Reporting only (WP-19). This route does not use `withErrorHandling` — it
 * owns its own responses for reasons documented above — so the wrapper adds
 * the Sentry report and nothing else: same error, same response, same status.
 */
export async function GET(request: NextRequest) {
  return reportingErrors("auth/native/start", () => handleGet(request));
}

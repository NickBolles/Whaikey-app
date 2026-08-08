import { NextRequest, NextResponse } from "next/server";
import { isNativeProvider } from "@/lib/native-auth";

/**
 * Step 1 of native sign-in (docs/NATIVE_APP.md §2.3).
 *
 * The app opens this URL in the **system browser**, not its own WebView, because
 * Google refuses OAuth from embedded WebViews (`disallowed_useragent`). All this
 * handler does is kick off the normal Better Auth social flow with a callback
 * that returns to `/api/auth/native/complete`, which is where the session gets
 * packaged up for the app.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get("provider");
  if (!isNativeProvider(provider)) {
    return NextResponse.json(
      { error: "Unsupported provider", details: "Expected google or apple." },
      { status: 400 },
    );
  }

  const { auth } = await import("@/lib/auth");

  try {
    const { url } = await auth.api.signInSocial({
      body: {
        provider,
        // Relative to the auth baseURL. After OAuth resolves, the browser lands
        // here already carrying the session cookie.
        callbackURL: "/api/auth/native/complete",
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
    return NextResponse.json({ error: "Sign-in unavailable" }, { status: 503 });
  }
}

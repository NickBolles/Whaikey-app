import { NextResponse } from "next/server";

/**
 * Apple Universal Links association file.
 *
 * iOS fetches this over HTTPS when the app is installed and, if it validates,
 * routes matching https:// links straight into the app instead of Safari. It
 * must be served at exactly `/.well-known/apple-app-site-association`, as JSON,
 * with **no file extension** — hence a route handler rather than a public/ file.
 *
 * The team prefix is deployment-specific, so it comes from the environment. With
 * it unset we 404 rather than publishing a malformed association, which iOS would
 * cache as a negative result.
 */
export const dynamic = "force-static";

/** Matches the entitlement in ios/App/App/App.entitlements. */
const BUNDLE_ID = "com.whaikey.app";

export async function GET() {
  const teamId = process.env.APPLE_TEAM_ID;
  if (!teamId) {
    return NextResponse.json({ error: "Not configured" }, { status: 404 });
  }

  return NextResponse.json(
    {
      applinks: {
        details: [
          {
            appIDs: [`${teamId}.${BUNDLE_ID}`],
            components: [
              // Deep-linkable surfaces. Everything else stays in the browser so
              // marketing pages and OAuth callbacks are never swallowed by the app.
              { "/": "/bottles/*" },
              { "/": "/bar" },
              { "/": "/pour*" },
              { "/": "/search*" },
              { "/": "/learn/*" },
            ],
          },
        ],
      },
    },
    {
      headers: {
        "content-type": "application/json",
        // iOS caches this aggressively; a short TTL keeps a fix reachable.
        "cache-control": "public, max-age=3600",
      },
    },
  );
}

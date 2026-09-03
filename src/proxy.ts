import { NextResponse, type NextRequest } from "next/server";

/**
 * The one thing this needs to do is tell the app which path it is rendering.
 *
 * The root layout enforces the age gate (PLAN.md §9.1) and has to exempt the
 * gate itself, or it redirects to a page that redirects to itself. A layout
 * has no access to the pathname, so it is passed down as a request header —
 * the documented way to get it there.
 *
 * Deliberately not the gate itself: a proxy runs before the app, may be
 * deployed to a CDN edge, and cannot read the database. Anything it decided
 * would rest on a cookie the client could set, which for an age gate is worse
 * than useless — it would look like a control while being an honour system
 * with extra steps.
 */
export const PATH_HEADER = "x-whaikey-path";

export function proxy(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  // Path *and* query: the gate sends people back where they were going, and
  // several of those places are only meaningful with their parameters —
  // `/pour?bottleId=…`, `/bottles/new?name=…&upc=…`. Dropping the search
  // string turns "carry on" into "start again".
  headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything the app renders; static assets and the image optimizer have no
  // layout and nothing to gate.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2)$).*)"],
};

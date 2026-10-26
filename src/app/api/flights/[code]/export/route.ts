import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSessionUser, withErrorHandling } from "@/lib/session";
import { findTaster, visibleFlightByCode, flightResultsCsv, getFlightView } from "@/lib/flights";
import { readGuestTokenFromHeader } from "@/lib/flights/guest-cookie";
import { BRAND_SLUG } from "@/lib/brand";

/** GET — results CSV for anyone seated at the table, after the reveal. */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const db = getDb();
    const user = await getSessionUser();
    const flight = await visibleFlightByCode(db, code, user?.id ?? null);
    if (!flight) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const taster = await findTaster(db, flight.id, {
      userId: user?.id ?? null,
      guestToken: readGuestTokenFromHeader(req.headers.get("cookie"), code),
    });
    if (!taster) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (flight.state === "open") return NextResponse.json({ error: "not_revealed" }, { status: 409 });
    const view = await getFlightView(db, flight, user?.id ?? null, taster);
    return new NextResponse(flightResultsCsv(view), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${BRAND_SLUG}-tasting-${code}.csv"`,
        "cache-control": "no-store",
      },
    });
  });
}

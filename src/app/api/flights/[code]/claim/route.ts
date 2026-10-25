import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { claimGuestSeat, flightByCode } from "@/lib/flights";
import { guestCookieName, readGuestTokenFromHeader } from "@/lib/flights/guest-cookie";

/** POST — a guest who just created an account keeps their ratings (D20). 404 without a live guest seat. */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { code } = await ctx.params;
    const db = getDb();
    const flight = await flightByCode(db, code);
    const token = readGuestTokenFromHeader(req.headers.get("cookie"), code);
    if (!flight || !token || !(await claimGuestSeat(db, flight.id, token, user.id))) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const res = NextResponse.json({ claimed: true });
    res.cookies.delete(guestCookieName(code));
    return res;
  });
}

import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { claimOutingGuestSeat, outingGuestCookieName, visibleOutingByCode } from "@/lib/outings";
import { readOutingGuestToken } from "@/lib/outings/request";

/** POST — a guest who just created an account keeps what they logged (D20). 404 without a live guest seat. */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { code } = await ctx.params;
    const db = getDb();
    const outing = await visibleOutingByCode(db, code, user.id);
    const token = readOutingGuestToken(req.headers.get("cookie"), code);
    if (!outing || !token || !(await claimOutingGuestSeat(db, outing.id, token, user.id))) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const res = NextResponse.json({ claimed: true });
    res.cookies.delete(outingGuestCookieName(code));
    return res;
  });
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { getSessionUser, requireUser, withErrorHandling } from "@/lib/session";
import { guestJoinSchema, joinOutingAsGuest, joinOutingAsUser, outingGuestCookieName, visibleOutingByCode } from "@/lib/outings";
import { guestCookieOptions } from "@/lib/flights/guest-cookie";

const bodySchema = z.object({ code: z.string().min(1).max(32), guest: guestJoinSchema.optional() }).strict();

/**
 * POST /api/outings/join { code, guest? } — join an outing. Signed in: as the
 * account (its age gate applies via requireUser). Signed out with `guest`:
 * the 21+ birth-date check, then a 24 h seat in an httpOnly cookie (D20).
 * 403 underage, 404 unknown/ended, 409 profile needed.
 */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const db = getDb();
    const session = await getSessionUser();
    const outing = await visibleOutingByCode(db, parsed.data.code, session?.id ?? null);
    if (!outing || outing.state !== "open") return NextResponse.json({ error: "not_found" }, { status: 404 });

    if (session || !parsed.data.guest) {
      const user = await requireUser();
      const result = await joinOutingAsUser(db, outing.id, user.id);
      if ("error" in result) {
        if (result.error === "profile_required") return NextResponse.json({ error: "profile_required" }, { status: 409 });
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return NextResponse.json({ joined: true, guest: false });
    }

    const result = await joinOutingAsGuest(db, outing.id, parsed.data.guest);
    if ("error" in result) {
      if (result.error === "underage") return NextResponse.json({ error: "underage" }, { status: 403 });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const res = NextResponse.json({ joined: true, guest: true, expiresAt: result.expiresAt });
    res.cookies.set(outingGuestCookieName(outing.joinCode), result.token!, guestCookieOptions(result.expiresAt!));
    return res;
  });
}

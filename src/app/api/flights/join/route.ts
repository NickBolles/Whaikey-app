import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { getSessionUser, requireUser, withErrorHandling } from "@/lib/session";
import { visibleFlightByCode, guestJoinSchema, joinAsGuest, joinAsUser } from "@/lib/flights";
import { guestCookieName, guestCookieOptions } from "@/lib/flights/guest-cookie";

const bodySchema = z.object({ code: z.string().min(1).max(32), guest: guestJoinSchema.optional() }).strict();

/**
 * POST /api/flights/join { code, guest? } — take a seat at a tasting night.
 * Signed in: as the account (the account's age gate applies via requireUser).
 * Signed out with `guest`: the 21+ birth-date check (D20), then a 24 h seat
 * held by an httpOnly cookie. 403 underage, 404 unknown/closed, 401 signed out
 * without guest details.
 */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const db = getDb();
    const session = await getSessionUser();
    const flight = await visibleFlightByCode(db, parsed.data.code, session?.id ?? null);
    if (!flight || flight.state === "closed") return NextResponse.json({ error: "not_found" }, { status: 404 });

    if (session || !parsed.data.guest) {
      const user = await requireUser();
      const result = await joinAsUser(db, flight.id, user.id);
      if ("error" in result) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ joined: true, guest: false });
    }

    const result = await joinAsGuest(db, flight.id, parsed.data.guest);
    if ("error" in result) {
      if (result.error === "underage") return NextResponse.json({ error: "underage" }, { status: 403 });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const res = NextResponse.json({ joined: true, guest: true, expiresAt: result.expiresAt });
    res.cookies.set(guestCookieName(flight.joinCode), result.token!, guestCookieOptions(result.expiresAt!));
    return res;
  });
}

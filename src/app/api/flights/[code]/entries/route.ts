import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSessionUser, withErrorHandling } from "@/lib/session";
import { entrySchema, findTaster, flightByCode, saveEntry } from "@/lib/flights";
import { readGuestTokenFromHeader } from "@/lib/flights/guest-cookie";

/**
 * PUT /api/flights/[code]/entries { slot, rating?, flavorTags?, note? } — save
 * the caller's rating for one glass while the flight is open. The caller is
 * their account's seat or their guest cookie's; 403 without a seat, 409 once
 * revealed.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const parsed = entrySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const db = getDb();
    const flight = await flightByCode(db, code);
    if (!flight) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const user = await getSessionUser();
    const taster = await findTaster(db, flight.id, {
      userId: user?.id ?? null,
      guestToken: readGuestTokenFromHeader(req.headers.get("cookie"), code),
    });
    if (!taster) return NextResponse.json({ error: "no_seat" }, { status: 403 });
    const row = await saveEntry(db, flight.id, taster, parsed.data);
    if (!row) return NextResponse.json({ error: "not_open" }, { status: 409 });
    return NextResponse.json({ slot: row.slot, rating: row.rating, flavorTags: row.flavorTags, note: row.note });
  });
}

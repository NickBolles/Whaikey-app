import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { flightByCode, setFlightState } from "@/lib/flights";

const schema = z.object({ to: z.enum(["revealed", "closed"]) }).strict();

/** POST /api/flights/[code]/state { to } — the host reveals for everyone (C4), or closes the night. */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { code } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const db = getDb();
    const flight = await flightByCode(db, code);
    if (!flight || flight.hostId !== user.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const row = await setFlightState(db, user.id, flight.id, parsed.data.to);
    if (!row) return NextResponse.json({ error: "invalid_transition" }, { status: 409 });
    return NextResponse.json({ state: row.state });
  });
}

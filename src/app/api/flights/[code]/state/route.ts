import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { getSessionUser, requireUser, withErrorHandling } from "@/lib/session";
import { flightByCode, setFlightState, visibleFlightByCode } from "@/lib/flights";

const schema = z.object({ to: z.enum(["revealed", "closed"]) }).strict();

type Ctx = { params: Promise<{ code: string }> };

/**
 * GET — the flight's state, polled by everyone at the table so the host's
 * reveal reaches every phone without a manual reload. Holding the code is
 * holding the invite; nothing but the state is returned.
 */
export async function GET(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const user = await getSessionUser();
    const flight = await visibleFlightByCode(getDb(), code, user?.id ?? null);
    if (!flight) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ state: flight.state }, { headers: { "cache-control": "no-store" } });
  });
}

/** POST /api/flights/[code]/state { to } — the host reveals for everyone (C4), or closes the night. */
export async function POST(req: Request, ctx: Ctx) {
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

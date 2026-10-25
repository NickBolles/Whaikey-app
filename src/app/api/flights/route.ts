import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { FlightClubError, createFlight, flightCreateSchema, listMyFlights } from "@/lib/flights";

/** GET /api/flights — tasting nights the caller hosts or joined. */
export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    return NextResponse.json({ items: await listMyFlights(getDb(), user.id) });
  });
}

/** POST /api/flights — host a tasting night with 3–6 bottles; 404 unknown bottle, 403 not in the club. */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const parsed = flightCreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    try {
      const flight = await createFlight(getDb(), user.id, parsed.data);
      if (!flight) return NextResponse.json({ error: "bottle_not_found" }, { status: 404 });
      return NextResponse.json({ id: flight.id, joinCode: flight.joinCode, path: `/f/${flight.joinCode}` }, { status: 201 });
    } catch (err) {
      if (err instanceof FlightClubError) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
      throw err;
    }
  });
}

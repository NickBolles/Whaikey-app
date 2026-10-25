import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { withErrorHandling } from "@/lib/session";
import { flightByCode, flightIcs } from "@/lib/flights";

/** GET — a calendar invite for the scheduled time. Holding the code is holding the invite. */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const flight = await flightByCode(getDb(), code);
    const ics = flight ? flightIcs(flight, new URL(req.url).origin) : null;
    if (!ics) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(ics, {
      headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="tasting-night.ics"` },
    });
  });
}

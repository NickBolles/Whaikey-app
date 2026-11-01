import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { touchOutingPresence } from "@/lib/outings";
import { resolveOuting } from "@/lib/outings/request";

type Ctx = { params: Promise<{ code: string }> };

/**
 * POST — heartbeat from the outing page while it is open and visible. Records
 * only that the caller has the page open, and returns which members on the
 * trip are "here now" (open in the last 2 minutes). People on the trip only;
 * nothing about pours or amounts is read or returned.
 */
export async function POST(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const { db, user, outing, seat } = await resolveOuting(req, code);
    if (!outing || !seat) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const here = await touchOutingPresence(db, outing, user?.id ?? null, seat);
    return NextResponse.json({ here }, { headers: { "cache-control": "no-store" } });
  });
}

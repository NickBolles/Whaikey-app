import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { endOuting, outingByCode, outingStamp } from "@/lib/outings";
import { resolveOuting } from "@/lib/outings/request";

const schema = z.object({ to: z.literal("ended") }).strict();
type Ctx = { params: Promise<{ code: string }> };

/**
 * GET — an opaque stamp that changes when the outing's feed or state does,
 * polled by people on the trip so new tastings appear without a reload.
 * Nothing about who is doing what right now is returned.
 */
export async function GET(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const { db, user, outing, seat } = await resolveOuting(req, code);
    if (!outing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const stamp = await outingStamp(db, outing, user?.id ?? null, seat);
    return NextResponse.json({ state: outing.state, stamp }, { headers: { "cache-control": "no-store" } });
  });
}

/** POST { to: "ended" } — the host ends the outing; the recap opens for everyone on it. */
export async function POST(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { code } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const db = getDb();
    const outing = await outingByCode(db, code);
    if (!outing || outing.hostId !== user.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const row = await endOuting(db, user.id, outing.id);
    if (!row) return NextResponse.json({ error: "invalid_transition" }, { status: 409 });
    return NextResponse.json({ state: row.state });
  });
}

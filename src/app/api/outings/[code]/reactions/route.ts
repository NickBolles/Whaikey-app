import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { outingMembers } from "@/lib/outings";
import { outingReactionSchema, setOutingReaction } from "@/lib/outings/social";
import { resolveOuting } from "@/lib/outings/request";

/** POST { targetKind, targetId, kind, on } — set or clear one reaction (idempotent). */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const parsed = outingReactionSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const { db, user, outing, seat } = await resolveOuting(req, code);
    if (!outing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!seat) return NextResponse.json({ error: "no_seat" }, { status: 403 });
    const members = await outingMembers(db, outing, user?.id ?? null);
    const r = await setOutingReaction(db, outing, seat.participantId, parsed.data, members);
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.error === "not_open" ? 409 : 404 });
    return NextResponse.json(r);
  });
}

import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { outingMembers } from "@/lib/outings";
import { addOutingComment, outingCommentSchema } from "@/lib/outings/social";
import { resolveOuting } from "@/lib/outings/request";

/**
 * POST { targetKind, targetId, body } — a short reply on a bottle on the list
 * or on someone's rating. People on the outing only; 404 for a target the
 * caller can't see (blocked author, hidden item), 409 once the outing ended,
 * 429 past the per-person cap.
 */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const parsed = outingCommentSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const { db, user, outing, seat } = await resolveOuting(req, code);
    if (!outing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!seat) return NextResponse.json({ error: "no_seat" }, { status: 403 });
    const members = await outingMembers(db, outing, user?.id ?? null);
    const r = await addOutingComment(db, outing, seat.participantId, parsed.data, members);
    if ("error" in r) {
      const status = r.error === "not_open" ? 409 : r.error === "too_many" ? 429 : 404;
      return NextResponse.json({ error: r.error }, { status });
    }
    return NextResponse.json(r, { status: 201 });
  });
}

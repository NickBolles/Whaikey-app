import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { outingMembers } from "@/lib/outings";
import { editOutingComment, outingCommentEditSchema, removeOutingComment } from "@/lib/outings/social";
import { resolveOuting } from "@/lib/outings/request";

type Ctx = { params: Promise<{ code: string; id: string }> };

/** PATCH { body } — edit your own reply while the outing is open. */
export async function PATCH(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code, id } = await ctx.params;
    const parsed = outingCommentEditSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const { db, user, outing, seat } = await resolveOuting(req, code);
    if (!outing || !seat) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const members = await outingMembers(db, outing, user?.id ?? null);
    if (!(await editOutingComment(db, outing, seat.participantId, id, parsed.data.body, members))) {
      return NextResponse.json({ error: outing.state === "open" ? "not_found" : "not_open" }, { status: outing.state === "open" ? 404 : 409 });
    }
    return NextResponse.json({ ok: true });
  });
}

/** DELETE — delete your own reply, or (the host) hide anyone's. */
export async function DELETE(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code, id } = await ctx.params;
    const { db, user, outing, seat } = await resolveOuting(req, code);
    if (!outing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const r = await removeOutingComment(db, outing, seat?.participantId ?? null, !!user && user.id === outing.hostId, id);
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ [r]: true });
  });
}

import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { removeOutingBottle } from "@/lib/outings";
import { resolveOuting } from "@/lib/outings/request";

/** DELETE — take a bottle you added off the list; the host can hide anyone's. Tastings stay. */
export async function DELETE(req: Request, ctx: { params: Promise<{ code: string; id: string }> }) {
  return withErrorHandling(async () => {
    const { code, id } = await ctx.params;
    const { db, user, outing, seat } = await resolveOuting(req, code);
    if (!outing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const isHost = !!user && user.id === outing.hostId;
    if (!seat && !isHost) return NextResponse.json({ error: "no_seat" }, { status: 403 });
    const ok = await removeOutingBottle(db, outing, seat, isHost, id);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  });
}

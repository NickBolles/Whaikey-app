import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { deleteOwnItem } from "@/lib/outings";
import { resolveOuting } from "@/lib/outings/request";

/** DELETE — remove your own note from the outing feed. */
export async function DELETE(req: Request, ctx: { params: Promise<{ code: string; id: string }> }) {
  return withErrorHandling(async () => {
    const { code, id } = await ctx.params;
    const { db, outing, seat } = await resolveOuting(req, code);
    if (!outing || !seat || !(await deleteOwnItem(db, outing, seat, "note", id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  });
}

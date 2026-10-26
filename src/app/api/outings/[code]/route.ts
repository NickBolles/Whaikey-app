import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { deleteOuting, outingByCode } from "@/lib/outings";

/** DELETE — the host deletes the outing and everything logged on it. 404 for anyone else. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { code } = await ctx.params;
    const db = getDb();
    const outing = await outingByCode(db, code);
    if (!outing || !(await deleteOuting(db, user.id, outing.id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  });
}

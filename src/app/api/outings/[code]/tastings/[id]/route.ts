import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { deleteOwnItem, tastingUpdateSchema, updateTasting } from "@/lib/outings";
import { resolveOuting } from "@/lib/outings/request";

type Ctx = { params: Promise<{ code: string; id: string }> };

/** PATCH — edit your own tasting (rating, descriptors, note) while the outing is open. */
export async function PATCH(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code, id } = await ctx.params;
    const parsed = tastingUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const { db, outing, seat } = await resolveOuting(req, code);
    if (!outing || !seat || !(await updateTasting(db, outing, seat, id, parsed.data))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ updated: true });
  });
}

/** DELETE — remove your own tasting. */
export async function DELETE(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code, id } = await ctx.params;
    const { db, outing, seat } = await resolveOuting(req, code);
    if (!outing || !seat || !(await deleteOwnItem(db, outing, seat, "tasting", id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  });
}

import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { clubUpdateSchema, deleteClub, updateClub } from "@/lib/clubs";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/clubs/[id] — owner/admin edits name/description; 404 otherwise. */
export async function PATCH(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const parsed = clubUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const row = await updateClub(getDb(), user.id, id, parsed.data);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ id: row.id, name: row.name, description: row.description });
  });
}

/** DELETE /api/clubs/[id] — owner only. */
export async function DELETE(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    if (!(await deleteClub(getDb(), user.id, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  });
}

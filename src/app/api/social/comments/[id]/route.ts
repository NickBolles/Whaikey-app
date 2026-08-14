import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { commentEditSchema, editComment, softDeleteComment } from "@/lib/social";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/social/comments/[id] { body } — author only, inside the edit window. */
export async function PATCH(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = commentEditSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const comment = await editComment(getDb(), user.id, id, parsed.data.body);
    if (!comment) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(comment);
  });
}

/** DELETE /api/social/comments/[id] — soft delete; author or the pour's owner. */
export async function DELETE(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const deleted = await softDeleteComment(getDb(), user.id, id);
    if (!deleted) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  });
}

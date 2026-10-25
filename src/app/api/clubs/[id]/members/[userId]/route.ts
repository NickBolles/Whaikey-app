import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { removeMember, roleSchema, setRole } from "@/lib/clubs";

type Ctx = { params: Promise<{ id: string; userId: string }> };

/** DELETE — leave (yourself) or remove a member (owner/admin); 404 when not allowed. */
export async function DELETE(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id, userId } = await ctx.params;
    const target = userId === "me" ? user.id : userId;
    if (!(await removeMember(getDb(), user.id, id, target))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ removed: true });
  });
}

/** PATCH { role } — owner promotes, demotes or hands over ownership; 404 when not allowed. */
export async function PATCH(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id, userId } = await ctx.params;
    const parsed = roleSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    if (!(await setRole(getDb(), user.id, id, userId, parsed.data.role))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ role: parsed.data.role });
  });
}

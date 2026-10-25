import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { createInvite } from "@/lib/clubs";

/** POST /api/clubs/[id]/invites — owner/admin mints a 7-day invite link; 404 otherwise. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const invite = await createInvite(getDb(), user.id, id);
    if (!invite) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ code: invite.code, path: `/clubs/join/${invite.code}`, expiresAt: invite.expiresAt }, { status: 201 });
  });
}

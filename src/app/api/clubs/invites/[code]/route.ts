import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { revokeInvite } from "@/lib/clubs";

/** DELETE /api/clubs/invites/[code] — owner/admin revokes an invite; 404 otherwise. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { code } = await ctx.params;
    if (!(await revokeInvite(getDb(), user.id, code))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ revoked: true });
  });
}

import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { unblockUser } from "@/lib/social";

type Ctx = { params: Promise<{ userId: string }> };

/** DELETE /api/social/blocks/[userId] — unblock a user. */
export async function DELETE(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { userId } = await ctx.params;
    const removed = await unblockUser(getDb(), user.id, userId);
    if (!removed) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ removed: true });
  });
}

import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { approveFollow } from "@/lib/social";

type Ctx = { params: Promise<{ userId: string }> };

/** POST /api/social/follows/[userId]/approve — accept a pending follow request. */
export async function POST(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { userId } = await ctx.params;
    const approved = await approveFollow(getDb(), user.id, userId);
    if (!approved) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ approved: true });
  });
}

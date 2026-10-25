import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { clubChallengeSchema, createClubChallenge } from "@/lib/challenges";
import { appNow } from "@/lib/clock";

/** POST — owner/admin starts a club challenge from the distinct-only templates; 404 otherwise. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const parsed = clubChallengeSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const row = await createClubChallenge(getDb(), user.id, id, parsed.data, appNow());
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ slug: row.slug }, { status: 201 });
  });
}

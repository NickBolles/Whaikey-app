import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { joinChallenge, leaveChallenge } from "@/lib/challenges";

type Ctx = { params: Promise<{ slug: string }> };

/** POST — join a challenge you can see (curated, or your club's); 404 otherwise or once it has ended. */
export async function POST(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { slug } = await ctx.params;
    if (!(await joinChallenge(getDb(), user.id, slug))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ joined: true });
  });
}

/** DELETE — leave a challenge you have not completed (a crest, once earned, stays). */
export async function DELETE(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { slug } = await ctx.params;
    if (!(await leaveChallenge(getDb(), user.id, slug))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ left: true });
  });
}

import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { createPourShare } from "@/lib/pour-sharing";

type Ctx = { params: Promise<{ id: string }> };

/** Opt-in only: creates the owner-scoped short link for one pour and its note. */
export async function POST(_request: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const share = await createPourShare(getDb(), user.id, id);
    if (!share) return NextResponse.json({ error: "Pour not found" }, { status: 404 });
    return NextResponse.json({ code: share.code, path: `/s/${share.code}` }, { status: 201 });
  });
}

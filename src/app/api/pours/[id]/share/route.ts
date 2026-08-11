import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { createPourShare } from "@/lib/pour-sharing";

const inputSchema = z.object({ locationLabel: z.string().max(80).optional().nullable() });

type Ctx = { params: Promise<{ id: string }> };

/** Opt-in only: creates the owner-scoped short link for one pour and its note. */
export async function POST(_request: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await _request.json().catch(() => ({}));
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid share options" }, { status: 400 });
    const share = await createPourShare(getDb(), user.id, id, parsed.data);
    if (!share) return NextResponse.json({ error: "Pour not found" }, { status: 404 });
    return NextResponse.json({ code: share.code, path: `/s/${share.code}` }, { status: 201 });
  });
}

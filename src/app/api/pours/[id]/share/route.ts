import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { createPourShare, revokePourShare } from "@/lib/pour-sharing";
import { PendingBottleError, SocialDisabledError } from "@/lib/pours";

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
    let share;
    try {
      share = await createPourShare(getDb(), user.id, id, parsed.data);
    } catch (err) {
      if (err instanceof SocialDisabledError) {
        return NextResponse.json({ error: "social_disabled" }, { status: 409 });
      }
      if (err instanceof PendingBottleError) {
        return NextResponse.json(
          {
            error: "pending_bottle",
            message: "That bottle is waiting to be reviewed, so this note can't be shared yet.",
          },
          { status: 409 },
        );
      }
      throw err;
    }
    if (!share) return NextResponse.json({ error: "Pour not found" }, { status: 404 });
    return NextResponse.json({ code: share.code, path: `/s/${share.code}` }, { status: 201 });
  });
}

/** Revokes the caller's own share link for this pour. Idempotent; the pour itself is untouched. */
export async function DELETE(_request: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const revoked = await revokePourShare(getDb(), user.id, id);
    if (!revoked) return NextResponse.json({ error: "Pour not found" }, { status: 404 });
    return NextResponse.json({ revoked: true }, { status: 200 });
  });
}

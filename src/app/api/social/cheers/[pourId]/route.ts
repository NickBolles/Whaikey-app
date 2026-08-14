import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { SocialDisabledError, cheerPour, getOwnProfile, uncheerPour } from "@/lib/social";

type Ctx = { params: Promise<{ pourId: string }> };

/** POST /api/social/cheers/[pourId] — cheer a visible pour. 409 profile_required, 404 not-visible. */
export async function POST(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { pourId } = await ctx.params;

    const db = getDb();
    const profile = await getOwnProfile(db, user.id);
    if (!profile) {
      return NextResponse.json({ error: "profile_required" }, { status: 409 });
    }
    if (!profile.socialEnabled) {
      // Contributions made while stepped back would resurface on re-enable;
      // reject them outright (docs/SOCIAL.md US-11).
      return NextResponse.json({ error: "social_disabled" }, { status: 409 });
    }

    let result;
    try {
      result = await cheerPour(db, user.id, pourId);
    } catch (err) {
      if (err instanceof SocialDisabledError) {
        return NextResponse.json({ error: "social_disabled" }, { status: 409 });
      }
      throw err;
    }
    if (!result) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(result);
  });
}

/** DELETE /api/social/cheers/[pourId] — remove the caller's cheer. 404 not-visible. */
export async function DELETE(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { pourId } = await ctx.params;

    const result = await uncheerPour(getDb(), user.id, pourId);
    if (!result) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(result);
  });
}

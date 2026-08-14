import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { POUR_VISIBILITIES } from "@/db/schema";
import { requireUser, withErrorHandling } from "@/lib/session";
import { SocialDisabledError, getSocialPrefs, updateSocialPrefs } from "@/lib/social";

const prefsPatchSchema = z.object({
  defaultPourVisibility: z.enum(POUR_VISIBILITIES).optional(),
  allowComments: z.boolean().optional(),
});

/** GET /api/social/prefs — the caller's social prefs (defaults when no row exists). */
export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const prefs = await getSocialPrefs(getDb(), user.id);
    return NextResponse.json(prefs);
  });
}

/** PATCH /api/social/prefs — partial update, upserting the row. */
export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = prefsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    let prefs;
    try {
      prefs = await updateSocialPrefs(getDb(), user.id, parsed.data);
    } catch (err) {
      if (err instanceof SocialDisabledError) {
        return NextResponse.json({ error: "social_disabled" }, { status: 409 });
      }
      throw err;
    }
    return NextResponse.json(prefs);
  });
}

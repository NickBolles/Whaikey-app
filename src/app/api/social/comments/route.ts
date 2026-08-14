import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { RateLimitedError, addComment, commentCreateSchema, getOwnProfile, listComments } from "@/lib/social";

/** GET /api/social/comments?pourId= — no profile needed to read; 404 when the pour isn't visible. */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const url = new URL(req.url);
    const pourId = url.searchParams.get("pourId");
    if (!pourId) {
      return NextResponse.json({ error: "pourId is required" }, { status: 400 });
    }

    const items = await listComments(getDb(), user.id, pourId);
    if (!items) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ items });
  });
}

/**
 * POST /api/social/comments { pourId, body, parentId? } — 409 profile_required;
 * 404 when the pour isn't visible, the owner has comments off, or parentId is
 * missing/foreign (all indistinguishable at the lib layer, by design).
 */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = commentCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const db = getDb();
    const profile = await getOwnProfile(db, user.id);
    if (!profile) {
      return NextResponse.json({ error: "profile_required" }, { status: 409 });
    }

    let comment;
    try {
      comment = await addComment(db, user.id, parsed.data.pourId, parsed.data.body, parsed.data.parentId);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return NextResponse.json({ error: "rate_limited" }, { status: 429 });
      }
      throw err;
    }
    if (!comment) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(comment, { status: 201 });
  });
}

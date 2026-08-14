import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { followByHandle, getOwnProfile, listFollowRequests, listFollowers, listFollowing } from "@/lib/social";

const FOLLOW_LIST_TYPES = ["following", "followers", "requests"] as const;
type FollowListType = (typeof FOLLOW_LIST_TYPES)[number];

const followCreateSchema = z.object({ handle: z.string().min(1) });

/** GET /api/social/follows?type=following|followers|requests (default following). */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const url = new URL(req.url);
    const rawType = url.searchParams.get("type") ?? "following";
    if (!FOLLOW_LIST_TYPES.includes(rawType as FollowListType)) {
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
    }
    const type = rawType as FollowListType;

    const db = getDb();
    const items =
      type === "following"
        ? await listFollowing(db, user.id)
        : type === "followers"
          ? await listFollowers(db, user.id)
          : await listFollowRequests(db, user.id);
    return NextResponse.json({ items });
  });
}

/** POST /api/social/follows { handle } — follow or request to follow. */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = followCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

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

    const result = await followByHandle(db, user.id, parsed.data.handle);
    if (!result) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ state: result.state });
  });
}

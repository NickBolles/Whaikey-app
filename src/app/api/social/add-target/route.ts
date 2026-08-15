import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { getAddTarget } from "@/lib/social";

/**
 * GET /api/social/add-target?handle= — the light identity projection behind
 * the /add/[handle] confirm screen (and its post-follow client refresh). 404
 * for a missing handle param or when getAddTarget returns null (missing
 * profile, socialEnabled=false, or a block either way — isSelf still 200s).
 */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const url = new URL(req.url);
    const handle = url.searchParams.get("handle");
    if (!handle) {
      return NextResponse.json({ error: "handle is required" }, { status: 400 });
    }

    const target = await getAddTarget(getDb(), user.id, handle);
    if (!target) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ target });
  });
}

import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { decodeFeedCursor, encodeFeedCursor, getFriendFeed } from "@/lib/social";
import { getPalateMatches } from "@/lib/taste-twins";
import { toFeedItemJson } from "@/lib/feed";

const PAGE = 20;

/**
 * GET /api/feed?cursor= — the Friends-tab feed (docs/SOCIAL.md §7.3, D15),
 * newest first, cursor-paged. Visibility, blocks, suspension and stepped-back
 * authors are enforced inside `getFriendFeed` on every page.
 */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const raw = new URL(req.url).searchParams.get("cursor");
    const before = decodeFeedCursor(raw);
    if (raw && !before) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    const db = getDb();
    const items = await getFriendFeed(db, user.id, { limit: PAGE, before });
    const matches = await getPalateMatches(db, user.id, items.map((i) => i.author.userId));
    const last = items[items.length - 1];
    return NextResponse.json({
      items: items.map((i) => toFeedItemJson(i, matches)),
      nextCursor: items.length === PAGE && last ? encodeFeedCursor({ createdAt: last.createdAt, pourId: last.pourId }) : null,
    });
  });
}

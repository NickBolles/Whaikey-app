import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { listInbox, unreadCount } from "@/lib/notify";

/** GET /api/notifications?before=<iso>~<id> — the caller's inbox, newest first, plus the unread count. */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    // Cursor: `<iso>~<id>` — the timestamp alone would skip rows sharing it across a page boundary.
    const raw = new URL(req.url).searchParams.get("before");
    let before: { createdAt: Date; id: string } | undefined;
    if (raw) {
      const i = raw.indexOf("~");
      const createdAt = new Date(i > 0 ? raw.slice(0, i) : "");
      const id = i > 0 ? raw.slice(i + 1) : "";
      if (Number.isNaN(createdAt.getTime()) || !id || id.length > 64) return NextResponse.json({ error: "Invalid before" }, { status: 400 });
      before = { createdAt, id };
    }
    const db = getDb();
    const [items, unread] = await Promise.all([listInbox(db, user.id, { before }), unreadCount(db, user.id)]);
    return NextResponse.json({ items, unread });
  });
}

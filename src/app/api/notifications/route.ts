import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { listInbox, unreadCount } from "@/lib/notify";

/** GET /api/notifications?before=<iso> — the caller's inbox, newest first, plus the unread count. */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const raw = new URL(req.url).searchParams.get("before");
    const before = raw ? new Date(raw) : undefined;
    if (before && Number.isNaN(before.getTime())) return NextResponse.json({ error: "Invalid before" }, { status: 400 });
    const db = getDb();
    const [items, unread] = await Promise.all([listInbox(db, user.id, { before }), unreadCount(db, user.id)]);
    return NextResponse.json({ items, unread });
  });
}

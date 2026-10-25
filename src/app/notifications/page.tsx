import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { listInbox, unreadCount } from "@/lib/notify";
import { InboxList } from "./inbox-list";

export const dynamic = "force-dynamic";

const PAGE = 30;

/**
 * The in-app inbox (docs/SOCIAL.md D18). Always works, push or no push.
 * Opening it marks everything read — there is no unread badge to clear by
 * hand and nothing here asks you to come back.
 */
export default async function NotificationsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const db = getDb();
  const [items, unread] = await Promise.all([listInbox(db, user.id, { limit: PAGE }), unreadCount(db, user.id)]);
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-3 pb-24 pt-5">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight">Notifications</h1>
        <Link href="/settings#notifications" className="text-xs text-muted hover:text-foreground">
          Settings
        </Link>
      </header>
      {items.length === 0 ? (
        <p className="card-flat p-4 text-sm text-muted">
          Nothing yet. Cheers, comments, new followers and club news land here.
        </p>
      ) : (
        <InboxList
          items={items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() }))}
          hasUnread={unread > 0}
          pageSize={PAGE}
        />
      )}
    </div>
  );
}

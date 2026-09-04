import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { feedback, user as userTable } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";

export const dynamic = "force-dynamic";

/**
 * What people sent through `/support` (PLAN.md §9.7).
 *
 * The point of storing feedback rather than mailing it is that somebody reads
 * it — a table nobody opens is the same mistake as the reports table this lane
 * exists to fix.
 */
export default async function AdminFeedbackPage() {
  const viewer = await getSessionUser();
  if (!isOperator(viewer)) notFound();

  const rows = await getDb()
    .select({
      id: feedback.id,
      body: feedback.body,
      contact: feedback.contact,
      platform: feedback.platform,
      appVersion: feedback.appVersion,
      createdAt: feedback.createdAt,
      senderName: userTable.name,
      senderEmail: userTable.email,
    })
    .from(feedback)
    .leftJoin(userTable, eq(userTable.id, feedback.userId))
    .orderBy(desc(feedback.createdAt))
    .limit(100);

  return (
    <div className="px-4 py-8 max-w-3xl mx-auto w-full flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-semibold">Feedback</h1>
        <p className="text-sm text-muted">
          {rows.length === 0 ? "Nothing yet." : `${rows.length} most recent`}
        </p>
      </header>

      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.id} className="card p-4 flex flex-col gap-2">
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{row.body}</p>
            <p className="text-xs text-muted">
              {row.senderName ? `${row.senderName} (${row.senderEmail})` : "signed out"}
              {row.contact && ` · replies to ${row.contact}`}
              {row.platform && ` · ${row.platform}`}
              {row.appVersion && ` ${row.appVersion}`}
              {` · ${row.createdAt.toLocaleString()}`}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

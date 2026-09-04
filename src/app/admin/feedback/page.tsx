import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";
import { countOutstandingFeedback, listFeedback } from "@/lib/feedback";
import { FeedbackList } from "./feedback-list";

export const dynamic = "force-dynamic";

/**
 * What people sent through `/support` (PLAN.md §9.7).
 *
 * The point of storing feedback rather than mailing it is that somebody reads
 * it — a table nobody opens is the same mistake as the reports table this lane
 * exists to fix. Which is also why each row can be marked handled: a list with
 * no way to say "dealt with" is that mistake one level down.
 */
export default async function AdminFeedbackPage() {
  const viewer = await getSessionUser();
  if (!isOperator(viewer)) notFound();

  const db = getDb();
  // The page is bounded, so the backlog is counted in SQL rather than read off
  // the rows that fit on it.
  const [rows, outstanding] = await Promise.all([listFeedback(db), countOutstandingFeedback(db)]);
  const shownOutstanding = rows.filter((r) => r.handledAt == null).length;

  return (
    <div className="px-4 py-8 max-w-3xl mx-auto w-full flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-semibold">Feedback</h1>
        <p className="text-sm text-muted">
          {rows.length === 0 ? "Nothing yet." : `${outstanding} outstanding`}
          {outstanding > shownOutstanding && ` · showing the ${shownOutstanding} oldest`}
        </p>
        <nav className="flex gap-3 text-sm">
          <Link href="/admin/reports" className="text-accent hover:underline">
            Reports →
          </Link>
          <Link href="/admin/submissions" className="text-accent hover:underline">
            Submitted bottles →
          </Link>
        </nav>
      </header>

      <FeedbackList
        rows={rows.map((row) => ({
          id: row.id,
          body: row.body,
          contact: row.contact,
          platform: row.platform,
          appVersion: row.appVersion,
          createdAt: row.createdAt.toISOString(),
          handled: row.handledAt != null,
          senderName: row.senderName,
          senderEmail: row.senderEmail,
        }))}
      />
    </div>
  );
}

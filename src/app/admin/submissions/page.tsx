import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";
import { countPendingSubmissions, listPendingSubmissions } from "@/lib/catalog";
import { SubmissionQueue } from "./submission-queue";

export const dynamic = "force-dynamic";

/**
 * The catalog review queue (PLAN.md §9.4, review PLAN-A1).
 *
 * WP-16 built the submission path and this is the other end of it: until this
 * screen existed, a bottle somebody added stayed private to them forever, and
 * the copy on `/bottles/new` promised a review nobody could perform.
 *
 * `notFound()` rather than a 403, same as `/admin/reports`.
 */
export default async function AdminSubmissionsPage() {
  const user = await getSessionUser();
  if (!isOperator(user)) notFound();

  const db = getDb();
  // One bounded page and the true backlog beside it: the array length alone
  // would read "100 waiting" forever once there were more than a hundred.
  const [submissions, pending] = await Promise.all([
    listPendingSubmissions(db),
    countPendingSubmissions(db),
  ]);

  return (
    <SubmissionQueue
      pending={pending}
      submissions={submissions.map((s) => ({
        ...s,
        createdAt: s.createdAt.toISOString(),
        isOwn: s.submittedBy === user?.id,
      }))}
    />
  );
}

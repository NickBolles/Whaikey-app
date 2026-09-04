import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";
import {
  REPORT_SLA_HOURS,
  REPORT_PAGE_SIZE,
  countBreachedReports,
  countOpenReports,
  listModerationActions,
  listOpenReports,
  listStandingHides,
  listSuspendedAccounts,
} from "@/lib/moderation";
import { ModerationQueue } from "./moderation-queue";

export const dynamic = "force-dynamic";

/**
 * The moderation queue (PLAN.md §9.4, review PLAN-C9).
 *
 * Reports have been written since social shipped and nothing read them. This
 * is the thing that reads them — and a store submission will ask for it,
 * because the app has profiles, feeds and comments whatever
 * `APP_STORE_SETUP.md` §6.2 used to say.
 *
 * `notFound()` rather than a 403 for a non-operator: the queue's existence is
 * not something a signed-in stranger needs confirmed.
 */
export default async function AdminReportsPage() {
  const user = await getSessionUser();
  if (!isOperator(user)) notFound();

  const db = getDb();
  const [reports, open, breached, audit, suspended, standingHides] = await Promise.all([
    // One bounded page. The header carries the true open count, so a backlog
    // is visible without the page trying to render all of it.
    listOpenReports(db),
    countOpenReports(db),
    countBreachedReports(db),
    listModerationActions(db, 50),
    // Suspending resolves the report, so the reinstate control next to it goes
    // away with the row. An appeal arriving later needs somewhere to be acted
    // on, and this is it.
    listSuspendedAccounts(db),
    // Its own query, not a filter over the audit list: that list is bounded
    // history, so a hide older than fifty actions would lose the only control
    // that lifts it — and an appeal about it would have no answer in the app.
    listStandingHides(db),
  ]);

  return (
    <ModerationQueue
      reports={reports.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        subjectOwnerSuspendedAt: r.subjectOwnerSuspendedAt?.toISOString() ?? null,
      }))}
      open={open}
      pageSize={REPORT_PAGE_SIZE}
      breached={breached}
      slaHours={REPORT_SLA_HOURS}
      audit={audit.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
      suspended={suspended.map((a) => ({ ...a, suspendedAt: a.suspendedAt.toISOString() }))}
      standingHides={standingHides.map((h) => ({ ...h, at: h.at.toISOString() }))}
    />
  );
}

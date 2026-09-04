import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";
import {
  REPORT_SLA_HOURS,
  countBreachedReports,
  listModerationActions,
  listOpenReports,
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
  const [reports, breached, audit, suspended] = await Promise.all([
    listOpenReports(db),
    countBreachedReports(db),
    listModerationActions(db, 50),
    // Suspending resolves the report, so the reinstate control next to it goes
    // away with the row. An appeal arriving later needs somewhere to be acted
    // on, and this is it.
    listSuspendedAccounts(db),
  ]);

  return (
    <ModerationQueue
      reports={reports.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
      breached={breached}
      slaHours={REPORT_SLA_HOURS}
      audit={audit.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
      suspended={suspended.map((a) => ({ ...a, suspendedAt: a.suspendedAt.toISOString() }))}
    />
  );
}

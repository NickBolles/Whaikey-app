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
/**
 * `<iso>|<id>`; anything else is treated as no cursor rather than an error,
 * since these are URLs a human can edit.
 */
function parseCursor(raw?: string): { at: Date; id: string } | undefined {
  if (!raw) return undefined;
  const cut = raw.lastIndexOf("|");
  if (cut < 1) return undefined;
  const at = new Date(raw.slice(0, cut));
  const id = raw.slice(cut + 1);
  if (Number.isNaN(at.getTime()) || !id) return undefined;
  return { at, id };
}

/** The standing-hides cursor is a bare `seq`; anything else is no cursor. */
function parseHidesCursor(raw?: string): number | undefined {
  if (!raw) return undefined;
  const seq = Number(raw);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

function parseSuspendedCursor(raw?: string): { at: Date; userId: string } | undefined {
  const parsed = parseCursor(raw);
  return parsed && { at: parsed.at, userId: parsed.id };
}

export default async function AdminReportsPage({
  searchParams,
}: {
  // A cursor rather than a cap: past a cap, the oldest takedowns lose the only
  // control that lifts them, which is the audit-window bug one level out.
  searchParams: Promise<{ hidesBefore?: string; suspendedBefore?: string }>;
}) {
  const { hidesBefore, suspendedBefore } = await searchParams;
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
    listSuspendedAccounts(db, { before: parseSuspendedCursor(suspendedBefore) }),
    // Its own query, not a filter over the audit list: that list is bounded
    // history, so a hide older than fifty actions would lose the only control
    // that lifts it — and an appeal about it would have no answer in the app.
    listStandingHides(db, { before: parseHidesCursor(hidesBefore) }),
  ]);

  return (
    <ModerationQueue
      reports={reports.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
      open={open}
      pageSize={REPORT_PAGE_SIZE}
      breached={breached}
      slaHours={REPORT_SLA_HOURS}
      audit={audit.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
      suspended={suspended.accounts.map((a) => ({
        ...a,
        suspendedAt: a.suspendedAt.toISOString(),
      }))}
      olderSuspendedCursor={suspended.nextCursor}
      standingHides={standingHides.hides.map((h) => ({ ...h, at: h.at.toISOString() }))}
      olderHidesCursor={standingHides.nextCursor}
    />
  );
}

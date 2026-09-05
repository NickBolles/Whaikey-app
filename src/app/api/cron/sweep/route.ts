import { NextResponse } from "next/server";
import { reportInBackground, reportingErrors } from "@/lib/observability/errors";
import { getDb } from "@/db";
import { runIndependently } from "@/lib/independently";
import { sweepExpiredCounters } from "@/lib/ai/rate-limit";
import { sweepExpiredSessions, sweepProviderTokens } from "@/lib/auth";
import { sweepOrphanedSubmissions } from "@/lib/catalog";
import { sweepNativeAuth } from "@/lib/native-auth";
import { sweepExpiredPhoneLookups } from "@/lib/social";
import { sweepTelemetry } from "@/lib/observability/metrics";

export const dynamic = "force-dynamic";

/**
 * Scheduled housekeeping (PLAN.md §9.2; the Privacy Policy's retention claim).
 *
 * Every table `/privacy` promises to prune, swept on a schedule rather than on
 * the traffic of the feature that writes it. Each of these had cleanup that
 * ran only from its own feature's code path, which is the wrong condition for
 * a retention promise: a deployment with no AI traffic kept rate-limit
 * counters, one with no native sign-ins kept **encrypted session cookies**,
 * and an account that stopped looking people up kept its phone probes. A
 * promise that holds only while the feature is in use is not the promise the
 * policy makes — and it is worth noting that the first version of this route
 * swept only the AI counters, so the same mistake survived its own fix.
 *
 * The opportunistic calls all stay: they are free, they keep the tables small
 * between runs, and they mean a missed schedule degrades rather than stops.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  /**
   * Unset means nobody may call it, not everybody — the same posture as
   * `WHAIKEY_OPERATOR_IDS`. This route does no user-visible work, so a
   * deployment that never configures it loses housekeeping, which is a smaller
   * failure than an open endpoint that runs deletes.
   */
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  /**
   * Still wrapped, but only for what is NOT one of the tasks below — `getDb()`,
   * a serialisation failure, anything outside the loop. Those still throw, and
   * unattended work is invisible when it fails. The tasks report for themselves
   * and do not rethrow, so the wrapper cannot double-file them.
   */
  return reportingErrors("cron/sweep", async () => {
    const db = getDb();
    const now = new Date();

    /**
     * Independent tasks, run independently (`runIndependently` states the
     * rule, because the same defect turned up again one level down inside
     * `sweepTelemetry` a round after this was fixed).
     *
     * They were a straight line of `await`s, so the FIRST one to throw ended
     * the request and every task after it was never attempted. This route is
     * scheduled once a day by `vercel.json` and is the only thing enforcing the
     * retention `/privacy` states, so a persistent failure in one unrelated
     * table left AI usage, share events and retracted cheers past their ninety
     * days **indefinitely** — and which tables those were depended on nothing
     * more meaningful than their position in this list. Nothing here depends on
     * anything else here succeeding.
     *
     * Ordered rather than parallel: they touch different tables but share a
     * connection pool, and a nightly job has no deadline worth a thundering
     * herd. Codes stay first because they hold encrypted session cookies.
     */
    const tasks: Array<readonly [string, () => Promise<unknown>]> = [
      // `force: true` because the once-per-process hour throttle exists to keep
      // the sweep off the request path; a schedule that asked for it gets it.
      ["ai-rate-limits", () => sweepExpiredCounters(db, now, { force: true })],
      ["native-auth", () => sweepNativeAuth(db, now)],
      ["phone-lookups", () => sweepExpiredPhoneLookups(db, now)],
      // Unapproved bottles whose submitter's account is gone — the one thing
      // here that is not a counter or a token. `bottles.submittedBy` is `set
      // null` so a *promoted* bottle outlives its submitter, but an unapproved
      // one is then visible to nobody and reviewable by nobody: user-entered
      // content surviving the account it belongs to. Swept here rather than at
      // account deletion because that path does not exist yet (SEC-M5).
      ["orphaned-submissions", () => sweepOrphanedSubmissions(db)],
      // Telemetry past its retention (WP-19), so the Privacy Policy's 90 days
      // is enforced by something rather than asserted — the gap WP-18 found in
      // the `ai_rate_limits` claim.
      ["telemetry", () => sweepTelemetry(db, now)],
      // Expired sessions. Better Auth stops honouring the row; nothing deletes
      // it, so a device that goes quiet leaves its bearer token, IP address and
      // user agent behind for good — which `/privacy` says does not happen.
      ["expired-sessions", () => sweepExpiredSessions(db, now)],
      // Provider tokens, unconditionally. Migration 0032 clears the ones that
      // predate encryption, but migrations run *before* the build that
      // activates it, so a sign-in served by the old deployment in that window
      // writes plaintext the migration will never see again. Nothing reads
      // these columns, so clearing them every run closes that window.
      ["provider-tokens", () => sweepProviderTokens(db)],
    ];

    const { outcomes, failed } = await runIndependently(tasks);
    for (const { name: task, error } of outcomes) {
      if (error === undefined) continue;
      /**
       * Reported per task, not once for the run. "The nightly sweep failed"
       * and "the phone-lookup sweep failed" are different alerts: each task is
       * a different table with a different root cause and a different fix, and
       * one event for the run would hide a second breakage behind the first.
       * Reported here and answered below rather than rethrown, so the wrapper
       * cannot file a duplicate on top — two events for one failure is how an
       * alert gets muted.
       */
      reportInBackground(error, { where: "cron/sweep", tags: { task } });
    }

    // A non-200 so the scheduler and its logs see a partial run for what it is,
    // naming what to look at without waiting for the alert to arrive.
    if (failed.length > 0) {
      return NextResponse.json({ ok: false, failed }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  });
}

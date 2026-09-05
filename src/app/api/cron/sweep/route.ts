import { NextResponse } from "next/server";
import { reportingErrors } from "@/lib/observability/errors";
import { getDb } from "@/db";
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

  // Unattended work is invisible when it fails, which is the one place error
  // reporting earns its keep most. Reports and rethrows: the response and the
  // status are unchanged (WP-19).
  return reportingErrors("cron/sweep", async () => {
    const db = getDb();
    const now = new Date();
    // `force: true` because the once-per-process hour throttle exists to keep the
    // sweep off the request path; a schedule that asked for it should get it.
    await sweepExpiredCounters(db, now, { force: true });
    // Codes first: they are the ones holding encrypted session cookies.
    await sweepNativeAuth(db, now);
    await sweepExpiredPhoneLookups(db, now);
    /**
     * And the one thing here that is not a counter or a token: unapproved
     * bottles whose submitter's account is gone. `bottles.submittedBy` is
     * `set null` so a *promoted* bottle outlives its submitter, but an
     * unapproved one is then visible to nobody and reviewable by nobody, which
     * is user-entered content surviving the account it belongs to. Swept here
     * rather than at account deletion because that path does not exist yet
     * (SEC-M5) — today deletion is a support request, so the cleanup has to
     * catch the result however the account went away.
     */
    await sweepOrphanedSubmissions(db);
    // Telemetry past its retention (WP-19). Bounded here rather than left to
    // grow, so the Privacy Policy's 90 days is enforced by something rather than
    // asserted — the gap WP-18 found in the `ai_rate_limits` claim.
    await sweepTelemetry(db, now);
    /**
     * And expired sessions. Better Auth stops honouring the row; nothing deletes
     * it, so a device that goes quiet leaves its bearer token, IP address and
     * user agent behind for good — which `/privacy` says does not happen.
     */
    await sweepExpiredSessions(db, now);
    /**
     * And the provider tokens, unconditionally. Migration 0032 clears the ones
     * that predate encryption, but migrations run *before* the build that
     * activates it — so a sign-in served by the old deployment during that
     * window writes plaintext the migration will never see again. Nothing reads
     * these columns, so clearing them on every run closes that window instead of
     * leaving it open forever.
     */
    await sweepProviderTokens(db);
    return NextResponse.json({ ok: true });
  });
}

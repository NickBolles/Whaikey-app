import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { sweepExpiredCounters } from "@/lib/ai/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Scheduled housekeeping (PLAN.md §9.2; the Privacy Policy's retention claim).
 *
 * `sweepExpiredCounters` was only ever reached from `reserveAiRequest`, which
 * makes it opportunistic: a deployment with no AI traffic — or an account that
 * goes dormant right after its last request — keeps rate-limit rows past the
 * "couple of days" `/privacy` states. A retention promise that holds only
 * while the feature it hangs off is being used is the same shape as the claim
 * WP-18 found with no sweep behind it at all, one step milder.
 *
 * The opportunistic call stays: it is free, it keeps the table small between
 * runs, and it means a missed schedule degrades rather than stops.
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

  // `force: true` because the once-per-process hour throttle exists to keep the
  // sweep off the request path; a schedule that asked for it should get it.
  await sweepExpiredCounters(getDb(), new Date(), { force: true });
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { sweepExpiredCounters } from "@/lib/ai/rate-limit";
import { sweepNativeAuth } from "@/lib/native-auth";
import { sweepExpiredPhoneLookups } from "@/lib/social";

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

  const db = getDb();
  const now = new Date();
  // `force: true` because the once-per-process hour throttle exists to keep the
  // sweep off the request path; a schedule that asked for it should get it.
  await sweepExpiredCounters(db, now, { force: true });
  // Codes first: they are the ones holding encrypted session cookies.
  await sweepNativeAuth(db, now);
  await sweepExpiredPhoneLookups(db, now);
  return NextResponse.json({ ok: true });
}

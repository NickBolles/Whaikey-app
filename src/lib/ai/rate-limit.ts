import { lt, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { aiRateLimits } from "@/db/schema";
import { reportInBackground } from "@/lib/observability/errors";

export const AI_HOURLY_LIMIT = 20;
export const AI_DAILY_LIMIT = 100;

/**
 * How long a spent counter row is kept.
 *
 * Long past the longest window it serves, so a sweep can never delete a
 * counter still being counted against — and short enough that the Privacy
 * Policy's "rate-limit counters are dropped after a couple of days" is true.
 * A row here is a user id and a timestamp; keeping it forever buys nothing and
 * is a retention claim we would have to keep making.
 */
export const RATE_LIMIT_RETENTION_MS = 48 * 60 * 60 * 1000;

/** At most one sweep per process per hour — it is housekeeping, not the job. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastSweep = 0;

function windowStart(now: Date, window: "hour" | "day"): Date {
  const result = new Date(now);
  if (window === "hour") result.setUTCMinutes(0, 0, 0);
  else result.setUTCHours(0, 0, 0, 0);
  return result;
}

/**
 * Atomically reserve one AI request in both durable UTC windows. Counters are
 * intentionally incremented only when every limit admits the request.
 */
export async function reserveAiRequest(db: DB, userId: string, now = new Date()): Promise<boolean> {
  const windows = [
    { window: "hour" as const, start: windowStart(now, "hour"), limit: AI_HOURLY_LIMIT },
    { window: "day" as const, start: windowStart(now, "day"), limit: AI_DAILY_LIMIT },
  ];

  await sweepExpiredCounters(db, now);

  return db.transaction(async (tx) => {
    for (const item of windows) {
      const [row] = await tx
        .insert(aiRateLimits)
        .values({ userId, window: item.window, windowStart: item.start, count: 1 })
        .onConflictDoUpdate({
          target: [aiRateLimits.userId, aiRateLimits.window, aiRateLimits.windowStart],
          set: { count: sql`${aiRateLimits.count} + 1` },
          where: sql`${aiRateLimits.count} < ${item.limit}`,
        })
        .returning({ count: aiRateLimits.count });
      if (!row) {
        // Roll back the transaction so a rejected daily request cannot consume
        // the hourly allowance (or vice versa).
        throw new AiRateLimitExceededError();
      }
    }
    return true;
  }).catch((error) => {
    if (error instanceof AiRateLimitExceededError) return false;
    throw error;
  });
}

/**
 * Drop counter rows whose window closed long ago.
 *
 * Outside the reservation transaction on purpose: a failed sweep must never
 * fail the request it rode in on, and a delete that rolled back with a
 * rejected reservation would never run at all.
 *
 * Called from two places, and it needs both: opportunistically from
 * `reserveAiRequest`, and on a schedule from `/api/cron/sweep`. The
 * opportunistic call alone made the retention claim conditional on AI traffic
 * — a dormant account or a quiet deployment kept its counters indefinitely,
 * which is not what `/privacy` says.
 */
export async function sweepExpiredCounters(
  db: DB,
  now = new Date(),
  /**
   * `force` skips the once-per-process hour throttle.
   *
   * That throttle exists to keep housekeeping off the request path, which is
   * the right default here and the wrong one for the scheduled call in
   * `/api/cron/sweep`: a schedule that asks for a sweep should get one rather
   * than be silently absorbed by whichever request last ran it.
   */
  options: { force?: boolean } = {},
): Promise<void> {
  if (!options.force && now.getTime() - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now.getTime();
  const cutoff = new Date(now.getTime() - RATE_LIMIT_RETENTION_MS);
  try {
    await db.delete(aiRateLimits).where(lt(aiRateLimits.windowStart, cutoff));
  } catch (err) {
    // Housekeeping, so it does not fail the request that happened to run it —
    // and the next call tries again in an hour. Reported because "tries again
    // in an hour" is only comforting while it eventually succeeds: a sweep
    // that fails every hour forever leaves `ai_rate_limits` growing without
    // bound and quietly breaks the retention `/privacy` promises, with nothing
    // user-facing to notice.
    console.error("[ai] could not sweep rate-limit counters", err);
    reportInBackground(err, { where: "ai/rate-limit:sweep" });
  }
}

/** Test seam: the sweep is once-per-process, which outlives a test database. */
export function resetSweepClockForTests(): void {
  lastSweep = 0;
}

class AiRateLimitExceededError extends Error {}

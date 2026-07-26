import { sql } from "drizzle-orm";
import type { DB } from "@/db";
import { aiRateLimits } from "@/db/schema";

export const AI_HOURLY_LIMIT = 20;
export const AI_DAILY_LIMIT = 100;

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

class AiRateLimitExceededError extends Error {}

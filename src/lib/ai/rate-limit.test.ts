import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb } from "@/test/helpers";
import { setErrorReporterForTests, type CapturedEvent } from "@/lib/observability/errors";
import {
  AI_DAILY_LIMIT,
  AI_HOURLY_LIMIT,
  RATE_LIMIT_RETENTION_MS,
  reserveAiRequest,
  resetSweepClockForTests,
  sweepExpiredCounters,
} from "./rate-limit";

let db: DB;
let userId: string;

beforeEach(async () => {
  db = await setupTestDb();
  userId = (await createTestUser(db)).id;
  // The sweep is throttled per process, which outlives a test database.
  resetSweepClockForTests();
});

describe("reserveAiRequest", () => {
  it("enforces the approved 20/hour durable limit without over-consuming a rejected request", async () => {
    const now = new Date("2026-07-25T12:34:56.000Z");
    await Promise.all(Array.from({ length: AI_HOURLY_LIMIT }, () => reserveAiRequest(db, userId, now)));
    expect(await reserveAiRequest(db, userId, now)).toBe(false);
    const rows = await db.select().from(schema.aiRateLimits);
    expect(rows.find((row) => row.window === "hour")?.count).toBe(AI_HOURLY_LIMIT);
    expect(rows.find((row) => row.window === "day")?.count).toBe(AI_HOURLY_LIMIT);
  });

  it("allows a new hour but stops at the approved 100/day limit", async () => {
    const day = new Date("2026-07-25T00:00:00.000Z");
    for (let hour = 0; hour < 5; hour += 1) {
      const now = new Date(day.getTime() + hour * 60 * 60 * 1000);
      for (let request = 0; request < AI_HOURLY_LIMIT; request += 1) {
        expect(await reserveAiRequest(db, userId, now)).toBe(true);
      }
    }
    expect(AI_DAILY_LIMIT).toBe(100);
    expect(await reserveAiRequest(db, userId, new Date("2026-07-25T05:00:00.000Z"))).toBe(false);
  });
});

/**
 * The Privacy Policy says rate-limit counters are dropped after a couple of
 * days. Nothing dropped them, which made the sentence false — and a policy
 * claim nothing enforces is worse than no claim.
 */
describe("sweepExpiredCounters", () => {
  it("drops counters whose window closed long ago and keeps the live ones", async () => {
    const now = new Date("2026-07-25T12:00:00.000Z");
    const stale = new Date(now.getTime() - RATE_LIMIT_RETENTION_MS - 60_000);
    await db.insert(schema.aiRateLimits).values([
      { userId, window: "hour", windowStart: stale, count: 3 },
      { userId, window: "day", windowStart: new Date("2026-07-25T00:00:00.000Z"), count: 7 },
    ]);

    await sweepExpiredCounters(db, now);

    const rows = await db.select().from(schema.aiRateLimits);
    expect(rows).toHaveLength(1);
    expect(rows[0].window).toBe("day");
  });

  it("runs at most once an hour, so it is housekeeping rather than the job", async () => {
    const now = new Date("2026-07-25T12:00:00.000Z");
    await sweepExpiredCounters(db, now);

    await db.insert(schema.aiRateLimits).values({
      userId,
      window: "hour",
      windowStart: new Date(now.getTime() - RATE_LIMIT_RETENTION_MS - 60_000),
      count: 1,
    });
    // A minute later: skipped, so the stale row is still there.
    await sweepExpiredCounters(db, new Date(now.getTime() + 60_000));
    expect(await db.select().from(schema.aiRateLimits)).toHaveLength(1);

    // Two hours later it runs again.
    await sweepExpiredCounters(db, new Date(now.getTime() + 2 * 60 * 60 * 1000));
    expect(await db.select().from(schema.aiRateLimits)).toHaveLength(0);
  });

  it("never removes a counter still being counted against", async () => {
    const now = new Date("2026-07-25T12:34:56.000Z");
    expect(await reserveAiRequest(db, userId, now)).toBe(true);
    // The reservation path sweeps before it counts; the row it just made must
    // survive its own sweep, or the limit resets on every request.
    resetSweepClockForTests();
    expect(await reserveAiRequest(db, userId, now)).toBe(true);
    const rows = await db.select().from(schema.aiRateLimits);
    expect(rows.find((row) => row.window === "hour")?.count).toBe(2);
  });
});


describe("the retention sweep is housekeeping, not a thing to lose quietly", () => {
  let captured: CapturedEvent[];
  beforeEach(() => {
    captured = [];
    setErrorReporterForTests((e) => captured.push(e));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    setErrorReporterForTests(null);
    vi.restoreAllMocks();
  });

  it("reports a sweep that cannot run, without failing the request that ran it", async () => {
    const real = db.delete.bind(db);
    db.delete = (() => ({
      where: () => Promise.reject(new Error("permission denied for ai_rate_limits")),
    })) as unknown as typeof db.delete;
    try {
      // Swallowed on purpose: a request that happens to trigger housekeeping
      // must not fail because the housekeeping did.
      await expect(sweepExpiredCounters(db, new Date(), { force: true })).resolves.toBeUndefined();
    } finally {
      db.delete = real;
    }
    // "The next call tries again in an hour" only comforts while it eventually
    // succeeds. Failing every hour forever grows the table without bound and
    // breaks the retention /privacy promises, with nothing user-facing to see.
    expect(captured.map((e) => e.context.where)).toContain("ai/rate-limit:sweep");
  });
});

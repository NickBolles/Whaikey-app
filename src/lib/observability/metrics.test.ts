import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { recordEvent } from "./analytics";
import {
  SESSIONS_WITHOUT_A_POUR_STATUS,
  TELEMETRY_RETENTION_DAYS,
  guardrailMetrics,
  operatorMetrics,
  shareFunnel,
  sweepTelemetry,
} from "./metrics";

let db: DB;
beforeEach(async () => {
  db = await setupTestDb();
});

const DAY = 86_400_000;

async function pour(
  userId: string,
  bottleId: string,
  opts: { at?: Date; visibility?: schema.PourVisibility } = {},
) {
  await db.insert(schema.pours).values({
    id: uid("pour"),
    userId,
    bottleId,
    visibility: opts.visibility ?? "private",
    ...(opts.at ? { createdAt: opts.at } : {}),
  });
}

describe("the guardrail metrics SOCIAL §12 committed to", () => {
  it("counts pours per active user per week over the window", async () => {
    const bottle = await createTestBottle(db);
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    await pour(a.id, bottle.id);
    await pour(a.id, bottle.id);
    await pour(a.id, bottle.id);
    await pour(b.id, bottle.id);

    const m = await guardrailMetrics(db);
    expect(m.activeUsers).toBe(2);
    expect(m.pours).toBe(4);
    expect(m.poursPerActiveUserPerWeek).toBeCloseTo(2, 6);
  });

  it("does not count pours from outside the window", async () => {
    const bottle = await createTestBottle(db);
    const user = await createTestUser(db);
    await pour(user.id, bottle.id);
    await pour(user.id, bottle.id, { at: new Date(Date.now() - 30 * DAY) });

    const m = await guardrailMetrics(db);
    expect(m.pours).toBe(1);
  });

  it("normalises to a week whatever window it is given", async () => {
    const bottle = await createTestBottle(db);
    const user = await createTestUser(db);
    const until = new Date();
    const since = new Date(until.getTime() - 14 * DAY);
    // Explicit timestamps inside the window. The first draft let the pours
    // default to `now`, which is AFTER the `until` captured a line earlier, so
    // the window excluded all four and the assertion failed against zero —
    // the test was wrong, not the maths.
    for (let i = 1; i <= 4; i++) {
      await pour(user.id, bottle.id, { at: new Date(until.getTime() - i * DAY) });
    }

    // Four pours over a fortnight is two a week; a raw count would call it
    // four and the guardrail would read as a doubling on a longer window.
    const m = await guardrailMetrics(db, { since, until });
    expect(m.poursPerActiveUserPerWeek).toBeCloseTo(2, 6);
  });

  it("counts a pour of an unshelved bottle as tried, not owned", async () => {
    const owned = await createTestBottle(db, { name: "Owned" });
    const sampled = await createTestBottle(db, { name: "Sampled" });
    const user = await createTestUser(db);
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: owned.id,
      relationship: "own",
    });
    await pour(user.id, owned.id);
    await pour(user.id, sampled.id);

    // A sample from a bar is not on your shelf and is exactly the breadth the
    // ratio is meant to reward — counting it as owned would invert the signal.
    const m = await guardrailMetrics(db);
    expect(m.ownedPours).toBe(1);
    expect(m.triedPours).toBe(1);
    expect(m.triedToOwnedPourRatio).toBeCloseTo(1, 6);
  });

  it("reports the tried:owned ratio as unknown rather than as infinity", async () => {
    const bottle = await createTestBottle(db);
    const user = await createTestUser(db);
    await pour(user.id, bottle.id);
    const m = await guardrailMetrics(db);
    // No owned pours at all: a ratio would be a division by zero, and "we
    // cannot say yet" is the honest reading of a denominator of none.
    expect(m.triedToOwnedPourRatio).toBeNull();
  });

  it("counts reports against social actions, not against all pours", async () => {
    const bottle = await createTestBottle(db);
    const author = await createTestUser(db);
    const reporter = await createTestUser(db);
    await pour(author.id, bottle.id, { visibility: "public" });
    await pour(author.id, bottle.id, { visibility: "private" });
    await db.insert(schema.reports).values({
      id: uid("report"),
      subjectType: "profile",
      subjectId: author.id,
      reporterId: reporter.id,
      reason: "abuse",
    });

    // A private pour is not a social action: including it would dilute the
    // rate and make a moderation problem look smaller as journalling grew.
    const m = await guardrailMetrics(db);
    expect(m.socialActions).toBe(1);
    expect(m.reportsPerThousandSocialActions).toBeCloseTo(1000, 6);
  });

  it("returns zeroes and nulls on an empty database rather than dividing by it", async () => {
    const m = await guardrailMetrics(db);
    expect(m.pours).toBe(0);
    expect(m.activeUsers).toBe(0);
    expect(m.poursPerActiveUserPerWeek).toBe(0);
    expect(m.triedToOwnedPourRatio).toBeNull();
    expect(m.reportsPerThousandSocialActions).toBeNull();
    expect(m.socialOffRate).toBeNull();
    expect(m.blockRate).toBeNull();
  });
});

describe("the S1 share funnel (PLAN-A5)", () => {
  async function shareOf(userId: string, bottleId: string): Promise<string> {
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId, bottleId, visibility: "private" });
    const id = uid("share");
    await db
      .insert(schema.pourShares)
      .values({ id, pourId, userId, code: uid("code") });
    return id;
  }

  it("computes the overlap rate S1 was supposed to answer", async () => {
    const owner = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const shareId = await shareOf(owner.id, bottle.id);
    const viewerA = await createTestUser(db);
    const viewerB = await createTestUser(db);

    await recordEvent(db, "share_view", { userId: viewerA.id, shareId });
    await recordEvent(db, "share_view", { userId: viewerB.id, shareId });
    await recordEvent(db, "share_view", { userId: null, shareId }); // signed out
    await recordEvent(db, "share_comparison_rendered", { userId: viewerA.id, shareId });
    await recordEvent(db, "share_wishlist_add", { userId: viewerB.id, shareId });

    const f = await shareFunnel(db);
    expect(f.views).toBe(3);
    // The denominator is signed-in views: a signed-out reader has no notes to
    // compare and cannot convert, so counting them would understate the rate.
    expect(f.viewsBySignedInUsers).toBe(2);
    expect(f.comparisonsRendered).toBe(1);
    expect(f.wishlistAddsFromShare).toBe(1);
    expect(f.comparisonRate).toBeCloseTo(0.5, 6);
  });

  it("says unknown rather than zero when nobody signed in has looked", async () => {
    const f = await shareFunnel(db);
    expect(f.comparisonRate).toBeNull();
  });
});

describe("what this deliberately does not measure", () => {
  it("names the missing metric instead of estimating it", async () => {
    const m = await operatorMetrics(db);
    // "Share of sessions with no pour logged" needs an app-open event, which
    // is a new and sensitive category of data and therefore an owner
    // decision. A guardrail read off an unvalidated proxy is worse than a
    // blank, because the blank is honest about not knowing.
    expect(m.notMeasured).toContain(SESSIONS_WITHOUT_A_POUR_STATUS);
  });
});

describe("telemetry retention", () => {
  it("sweeps rows past the retention and keeps the rest", async () => {
    const user = await createTestUser(db);
    const old = new Date(Date.now() - (TELEMETRY_RETENTION_DAYS + 1) * DAY);
    await db.insert(schema.aiUsage).values({
      id: uid("usage"),
      userId: user.id,
      feature: "chat",
      model: "m",
      createdAt: old,
    });
    await db.insert(schema.aiUsage).values({
      id: uid("usage"),
      userId: user.id,
      feature: "chat",
      model: "m",
    });
    await db.insert(schema.analyticsEvents).values({
      id: uid("ev"),
      name: "share_view",
      createdAt: old,
    });
    await db.insert(schema.analyticsEvents).values({ id: uid("ev"), name: "share_view" });

    const swept = await sweepTelemetry(db);
    expect(swept).toEqual({ aiUsage: 1, analyticsEvents: 1 });
    expect(await db.select().from(schema.aiUsage)).toHaveLength(1);
    expect(await db.select().from(schema.analyticsEvents)).toHaveLength(1);
  });

  it("enforces the number the Privacy Policy states", () => {
    // The policy says 90 days. WP-18 found a policy claim (`ai_rate_limits`)
    // that nothing enforced; this is the assertion that stops a second one.
    expect(TELEMETRY_RETENTION_DAYS).toBe(90);
  });
});

import { eq } from "drizzle-orm";
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
  opts: {
    at?: Date;
    visibility?: schema.PourVisibility;
    shelf?: schema.Relationship | null;
    /** Simulates a row written before the snapshot columns existed. */
    noSnapshot?: boolean;
  } = {},
) {
  const visibility = opts.visibility ?? "private";
  await db.insert(schema.pours).values({
    id: uid("pour"),
    userId,
    bottleId,
    visibility,
    // `logPour` writes both of these at pour time; fixtures do the same, or
    // deliberately omit them to stand in for pre-column history.
    ...(opts.noSnapshot
      ? {}
      : {
          shelfRelationshipAtPour: opts.shelf === undefined ? "tried" : opts.shelf,
          visibilityAtCreation: visibility,
        }),
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

  it("excludes accounts that joined inside the window from the adjusted figure", async () => {
    const bottle = await createTestBottle(db);
    const established = await createTestUser(db, {
      createdAt: new Date(Date.now() - 90 * DAY),
    });
    // Joined two days ago and logged a backlog of ten pours — one person's
    // history arriving at once, which is exactly the confounder SOCIAL §12
    // names and the reason it requires cohort adjustment.
    const newcomer = await createTestUser(db, { createdAt: new Date(Date.now() - 2 * DAY) });
    await pour(established.id, bottle.id);
    await pour(established.id, bottle.id);
    for (let i = 0; i < 10; i++) await pour(newcomer.id, bottle.id);

    const m = await guardrailMetrics(db);
    // Raw: 12 pours over 2 users = 6/week, which would read as a spike.
    expect(m.poursPerActiveUserPerWeek).toBeCloseTo(6, 6);
    // Adjusted: the established account alone, unchanged at 2/week.
    expect(m.establishedActiveUsers).toBe(1);
    expect(m.establishedPours).toBe(2);
    expect(m.establishedPoursPerActiveUserPerWeek).toBeCloseTo(2, 6);
  });

  it("reports the adjusted figure as unknown when every account is new", async () => {
    const bottle = await createTestBottle(db);
    const newcomer = await createTestUser(db, { createdAt: new Date(Date.now() - 1 * DAY) });
    await pour(newcomer.id, bottle.id);
    const m = await guardrailMetrics(db);
    // No established population to compare against: null, not zero. Zero would
    // read as "established users stopped drinking".
    expect(m.establishedPoursPerActiveUserPerWeek).toBeNull();
  });

  it("classifies a pour by what the shelf said AT POUR TIME", async () => {
    const bottle = await createTestBottle(db, { name: "Later Bought" });
    const user = await createTestUser(db);
    // Sampled at a bar, then bought later. The shelf row flips tried -> own,
    // and reading it today would reclassify the sample retroactively.
    await pour(user.id, bottle.id, { shelf: "tried" });
    await pour(user.id, bottle.id, { shelf: "own" });
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: bottle.id,
      relationship: "own",
    });

    const m = await guardrailMetrics(db);
    // One of each, despite the shelf now saying "own" for both.
    expect(m.triedPours).toBe(1);
    expect(m.ownedPours).toBe(1);
    expect(m.triedToOwnedPourRatio).toBeCloseTo(1, 6);
  });

  it("ignores pours written before the snapshot existed rather than guessing", async () => {
    const bottle = await createTestBottle(db);
    const user = await createTestUser(db);
    await pour(user.id, bottle.id, { noSnapshot: true });
    await pour(user.id, bottle.id, { shelf: "own" });

    // Falling back to the live shelf join for the null row IS the bug these
    // columns exist to fix, so an unknown stays out of both counts.
    const m = await guardrailMetrics(db);
    expect(m.triedPours + m.ownedPours).toBe(1);
    expect(m.ownedPours).toBe(1);
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

  it("keeps social actions that happened, after a privacy reset erases them", async () => {
    const bottle = await createTestBottle(db);
    const author = await createTestUser(db);
    const reporter = await createTestUser(db);
    await pour(author.id, bottle.id, { visibility: "public" });
    await db.insert(schema.reports).values({
      id: uid("report"),
      subjectType: "profile",
      subjectId: author.id,
      reporterId: reporter.id,
      reason: "abuse",
    });

    // What `makeEverythingPrivate` and a suspension both do: rewrite every
    // pour to private, including ones already published.
    await db
      .update(schema.pours)
      .set({ visibility: "private" })
      .where(eq(schema.pours.userId, author.id));

    const m = await guardrailMetrics(db);
    // The action still happened. Counting current visibility would drop the
    // denominator to zero and make reports-per-1,000 null — the safety metric
    // erased by the safety action, at exactly the moment it is being asked.
    expect(m.socialActions).toBe(1);
    expect(m.reportsPerThousandSocialActions).toBeCloseTo(1000, 6);
  });

  it("does not count an operator suspension as somebody choosing to leave", async () => {
    const quitter = await createTestUser(db);
    const suspended = await createTestUser(db);
    const operator = await createTestUser(db);
    for (const [u, handle] of [
      [quitter, "quitter"],
      [suspended, "suspended"],
    ] as const) {
      await db.insert(schema.userProfiles).values({
        userId: u.id,
        handle,
        displayName: handle,
        isPublic: true,
        socialEnabled: false,
      });
    }
    // A suspension sets socialEnabled = false, and WP-18 deliberately does not
    // restore it on reinstatement. Without this exclusion a moderation action
    // registers permanently as a voluntary step-back.
    // The row shape `suspendAccount` writes: action "suspend" against a
    // profile subject, with the operator's reason in `note`.
    await db.insert(schema.moderationActions).values({
      id: uid("action"),
      actorId: operator.id,
      action: "suspend",
      subjectType: "profile",
      subjectId: suspended.id,
      note: "abuse",
    });

    const m = await guardrailMetrics(db);
    // One profile counted, and it is the one who chose.
    expect(m.profiles).toBe(1);
    expect(m.socialOffRate).toBeCloseTo(1, 6);
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

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

/**
 * An `until` a moment in the future, for reads that immediately follow writes.
 *
 * The windows here are half-open — `[since, until)` — which is right, because
 * it is what stops two adjacent windows counting the same row twice. It also
 * means an event written in the SAME MILLISECOND as a read that defaults
 * `until` to `new Date()` falls outside it. In production that is a boundary
 * effect nobody can see; in a test that inserts and then immediately reads it
 * is a reliable failure, and one that disappears the moment you add a
 * `console.log` — which is exactly how this was found.
 */
const justAfterNow = () => new Date(Date.now() + 60_000);

async function pour(
  userId: string,
  bottleId: string,
  opts: {
    at?: Date;
    visibility?: schema.PourVisibility;
    shelf?: schema.Relationship | null;
    /** Simulates a row written before the snapshot columns existed. */
    noSnapshot?: boolean;
    /** When the pour first became visible, if that was not at creation. */
    sharedAt?: Date | null;
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
          // `logPour` stamps this when the pour is created visible; a pour
          // published later gets it from `updatePourVisibility` instead.
          firstSharedAt:
            opts.sharedAt ?? (visibility === "private" ? null : (opts.at ?? new Date())),
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

  it("counts a pour published later, in the window it was published in", async () => {
    const bottle = await createTestBottle(db);
    const author = await createTestUser(db);
    // Logged privately three months ago, published today. The creation
    // snapshot says "private" forever, so reading it alone counted nothing —
    // the mirror image of the bulk-privacy bug, and introduced by its fix.
    await pour(author.id, bottle.id, {
      visibility: "public",
      at: new Date(Date.now() - 90 * DAY),
      sharedAt: new Date(),
    });

    const m = await guardrailMetrics(db);
    // The window is on when it became visible, not when it was poured: that
    // is the moment a reader could see it, which is the event being counted.
    expect(m.socialActions).toBe(1);
  });

  it("counts publishing once, however many times the control is toggled", async () => {
    const bottle = await createTestBottle(db);
    const author = await createTestUser(db);
    // `updatePourVisibility` refuses to publish without an enabled profile.
    await db.insert(schema.userProfiles).values({
      userId: author.id,
      handle: "toggler",
      displayName: "toggler",
      isPublic: true,
    });
    const [row] = await db
      .insert(schema.pours)
      .values({
        id: uid("pour"),
        userId: author.id,
        bottleId: bottle.id,
        visibility: "private",
        visibilityAtCreation: "private",
      })
      .returning();

    const { updatePourVisibility } = await import("@/lib/pours");
    await updatePourVisibility(db, author.id, row.id, "public");
    const [first] = await db
      .select({ at: schema.pours.firstSharedAt })
      .from(schema.pours)
      .where(eq(schema.pours.id, row.id));
    expect(first.at).toBeInstanceOf(Date);

    await updatePourVisibility(db, author.id, row.id, "private");
    await updatePourVisibility(db, author.id, row.id, "followers");
    const [again] = await db
      .select({ at: schema.pours.firstSharedAt })
      .from(schema.pours)
      .where(eq(schema.pours.id, row.id));

    // Stamped once and never moved. A metric somebody can inflate by toggling
    // a control is the defect the cheer retraction already had.
    expect(again.at?.getTime()).toBe(first.at?.getTime());
    expect((await guardrailMetrics(db)).socialActions).toBe(1);
  });

  it("counts a pour shared by bearer link, which never touches the visibility control", async () => {
    const bottle = await createTestBottle(db);
    const author = await createTestUser(db);
    await db.insert(schema.userProfiles).values({
      userId: author.id,
      handle: "linker",
      displayName: "linker",
      isPublic: true,
    });
    const [row] = await db
      .insert(schema.pours)
      .values({
        id: uid("pour"),
        userId: author.id,
        bottleId: bottle.id,
        visibility: "private",
        visibilityAtCreation: "private",
      })
      .returning();

    const { createPourShare } = await import("@/lib/pour-sharing");
    await createPourShare(db, author.id, row.id);

    // A bearer link is how most sharing actually happens; it makes the pour
    // visible to another person without ever changing `visibility`. Stamping
    // only on the visibility control left this flow out of the denominator
    // forever, which inflates reports per thousand.
    const m = await guardrailMetrics(db);
    expect(m.socialActions).toBe(1);
  });

  it("does not stamp a pour that was already visible before the column existed", async () => {
    const bottle = await createTestBottle(db);
    const author = await createTestUser(db);
    await db.insert(schema.userProfiles).values({
      userId: author.id,
      handle: "historic",
      displayName: "historic",
      isPublic: true,
    });
    // A row from before migration 0037: already public, no first_shared_at.
    const [row] = await db
      .insert(schema.pours)
      .values({
        id: uid("pour"),
        userId: author.id,
        bottleId: bottle.id,
        visibility: "public",
        visibilityAtCreation: "public",
        createdAt: new Date(Date.now() - 200 * DAY),
      })
      .returning();

    const { updatePourVisibility } = await import("@/lib/pours");
    await updatePourVisibility(db, author.id, row.id, "friends");

    const [after] = await db
      .select({ at: schema.pours.firstSharedAt })
      .from(schema.pours)
      .where(eq(schema.pours.id, row.id));
    // Stamping now() here would file a publication from months ago as a social
    // action in this week's window. Null and excluded is the honest answer for
    // history the column did not exist for.
    expect(after.at).toBeNull();
    expect((await guardrailMetrics(db)).socialActions).toBe(0);
  });

  it("does not stamp a link on a pour that was already visible before the column existed", async () => {
    const author = await createTestUser(db);
    const bottle = await createTestBottle(db);
    await db.insert(schema.userProfiles).values({
      userId: author.id,
      handle: "historic-link",
      displayName: "historic-link",
      isPublic: true,
    });
    // A pre-0037 row: already public, no stamp.
    const [row] = await db
      .insert(schema.pours)
      .values({
        id: uid("pour"),
        userId: author.id,
        bottleId: bottle.id,
        visibility: "public",
        visibilityAtCreation: "public",
        createdAt: new Date(Date.now() - 200 * DAY),
      })
      .returning();

    const { createPourShare } = await import("@/lib/pour-sharing");
    await createPourShare(db, author.id, row.id);

    const [after] = await db
      .select({ at: schema.pours.firstSharedAt })
      .from(schema.pours)
      .where(eq(schema.pours.id, row.id));
    /**
     * `updatePourVisibility` already refused to invent a date for these rows;
     * the bearer-link path — added in the SAME commit as that guard — did not
     * carry it, so making a link for a months-old public pour filed the old
     * publication as this week's social action.
     */
    expect(after.at).toBeNull();
    expect((await guardrailMetrics(db)).socialActions).toBe(0);
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

  it("counts blockers out of the same population the rate divides by", async () => {
    const blocker = await createTestUser(db);
    const suspendedBlocker = await createTestUser(db);
    const target = await createTestUser(db);
    const operator = await createTestUser(db);
    for (const [u, handle] of [
      [blocker, "blocker"],
      [suspendedBlocker, "suspended-blocker"],
      [target, "target"],
    ] as const) {
      await db.insert(schema.userProfiles).values({
        userId: u.id,
        handle,
        displayName: handle,
        isPublic: true,
      });
    }
    await db.insert(schema.moderationActions).values({
      id: uid("action"),
      actorId: operator.id,
      action: "suspend",
      subjectType: "profile",
      subjectId: suspendedBlocker.id,
      note: "abuse",
    });
    for (const b of [blocker, suspendedBlocker]) {
      await db
        .insert(schema.blocks)
        .values({ id: uid("block"), blockerId: b.id, blockedId: target.id });
    }

    const m = await guardrailMetrics(db);
    // Two profiles survive the suspension filter; one of them has blocked
    // somebody. The earlier version counted distinct blockers across the whole
    // table — including the suspended one, who is not in the denominator — so
    // this read 2/2 and every suspension pushed it further up.
    expect(m.profiles).toBe(2);
    expect(m.blockRate).toBeCloseTo(0.5, 6);
  });

  it("never reports a block rate above everyone", async () => {
    // The shape that made the mismatch visible: a blocker with no profile row
    // at all is outside the denominator entirely, so counting them made a
    // "share of profiles" exceed 1.
    const profileless = await createTestUser(db);
    const target = await createTestUser(db);
    await db.insert(schema.userProfiles).values({
      userId: target.id,
      handle: "target",
      displayName: "target",
      isPublic: true,
    });
    await db
      .insert(schema.blocks)
      .values({ id: uid("block"), blockerId: profileless.id, blockedId: target.id });

    const m = await guardrailMetrics(db);
    expect(m.blockRate).toBe(0);
  });

  it("keeps a cheer that was taken back inside the window it happened in", async () => {
    const author = await createTestUser(db);
    const reader = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "followers" });
    await db
      .insert(schema.reactions)
      .values({ id: uid("cheer"), pourId, userId: reader.id, kind: "cheers" });
    await db.insert(schema.reports).values({
      id: uid("report"),
      reporterId: reader.id,
      subjectType: "pour",
      subjectId: pourId,
      reason: "other",
    });

    const before = await guardrailMetrics(db);
    expect(before.socialActions).toBe(1);
    expect(before.reportsPerThousandSocialActions).toBeCloseTo(1000, 6);

    // The reader changes their mind. What the UI shows must change; what last
    // week's guardrail says must not.
    const { uncheerPour } = await import("@/lib/social");
    await uncheerPour(db, reader.id, pourId);

    const after = await guardrailMetrics(db);
    expect(after.socialActions).toBe(1);
    expect(after.reportsPerThousandSocialActions).toBeCloseTo(1000, 6);
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

    const f = await shareFunnel(db, { until: justAfterNow() });
    expect(f.views).toBe(3);
    // The denominator is signed-in views: a signed-out reader has no notes to
    // compare and cannot convert, so counting them would understate the rate.
    expect(f.viewsBySignedInUsers).toBe(2);
    expect(f.comparisonsRendered).toBe(1);
    expect(f.wishlistAddsFromShare).toBe(1);
    expect(f.comparisonRate).toBeCloseTo(0.5, 6);
  });

  it("counts a shelf add from a share separately from a wishlist add", async () => {
    const owner = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const shareId = await shareOf(owner.id, bottle.id);
    const viewer = await createTestUser(db);

    await recordEvent(db, "share_shelf_add", { userId: viewer.id, shareId });

    const f = await shareFunnel(db, { until: justAfterNow() });
    // Not folded in: `wishlistAddsFromShare` is read as "people who wanted the
    // bottle", and someone who already owns it is a different answer.
    expect(f.wishlistAddsFromShare).toBe(0);
    expect(f.shelfAddsFromShare).toBe(1);
  });

  it("keeps the funnel numbers when the underlying pour is deleted", async () => {
    const owner = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const viewer = await createTestUser(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: owner.id, bottleId: bottle.id, visibility: "private" });
    const shareId = uid("share");
    await db
      .insert(schema.pourShares)
      .values({ id: shareId, pourId, userId: owner.id, code: uid("code") });

    await recordEvent(db, "share_view", { userId: viewer.id, shareId });
    await recordEvent(db, "share_wishlist_add", { userId: viewer.id, shareId });
    const before = await shareFunnel(db, { until: justAfterNow() });
    expect(before.views).toBe(1);
    expect(before.wishlistAddsFromShare).toBe(1);

    // Shares cascade from pours, so a `cascade` on share_id meant deleting one
    // ordinary journal entry erased every view and conversion ever recorded
    // against its link — rewriting a past month's S1 numbers as a side effect
    // of an unrelated action today.
    await db.delete(schema.pours).where(eq(schema.pours.id, pourId));

    const after = await shareFunnel(db, { until: justAfterNow() });
    expect(after.views).toBe(1);
    expect(after.wishlistAddsFromShare).toBe(1);
    // The reference goes, the measurement stays.
    const rows = await db.select().from(schema.analyticsEvents);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.shareId === null)).toBe(true);
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
    expect(swept).toEqual({ aiUsage: 1, analyticsEvents: 1, retractedCheers: 0 });
    expect(await db.select().from(schema.aiUsage)).toHaveLength(1);
    expect(await db.select().from(schema.analyticsEvents)).toHaveLength(1);
  });

  it("drops a withdrawn cheer once the window it was kept for has passed", async () => {
    const author = await createTestUser(db);
    const reader = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const old = new Date(Date.now() - (TELEMETRY_RETENTION_DAYS + 1) * DAY);

    async function cheer(retractedAt: Date | null, createdAt?: Date) {
      const pourId = uid("pour");
      await db
        .insert(schema.pours)
        .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
      await db.insert(schema.reactions).values({
        id: uid("cheer"),
        pourId,
        userId: reader.id,
        kind: "cheers",
        ...(createdAt ? { createdAt } : {}),
        retractedAt,
      });
    }

    await cheer(old); // withdrawn long ago — the guardrail no longer needs it
    await cheer(new Date()); // withdrawn just now — still inside a live window
    await cheer(null, old); // an OLD cheer that still stands: not telemetry at all

    const swept = await sweepTelemetry(db);
    expect(swept.retractedCheers).toBe(1);
    // Cut on `retracted_at`, not `created_at`: a years-old cheer somebody
    // still stands behind is a social object, and sweeping it would delete a
    // count the UI is currently rendering.
    const left = await db.select().from(schema.reactions);
    expect(left).toHaveLength(2);
    expect(left.filter((r) => r.retractedAt === null)).toHaveLength(1);
  });

  it("enforces the number the Privacy Policy states", () => {
    // The policy says 90 days. WP-18 found a policy claim (`ai_rate_limits`)
    // that nothing enforced; this is the assertion that stops a second one.
    expect(TELEMETRY_RETENTION_DAYS).toBe(90);
  });
});

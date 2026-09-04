import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  CannotHideProfileError,
  REPORT_SLA_HOURS,
  UnknownSubjectError,
  countBreachedReports,
  dismissReport,
  hideSubject,
  listModerationActions,
  listOpenReports,
  subjectPreview,
  listSuspendedAccounts,
  isModerationHidden,
  moderationNoticeFor,
  unhideSubject,
  countOpenReports,
  commentNoticesForAuthor,
  ReportAlreadyHandledError,
  ReportSubjectMismatchError,
  StaleModerationViewError,
  listOwnModerationHolds,
  listStandingHides,
  reinstateAccount,
  suspendAccount,
} from "./moderation";
import {
  AccountSuspendedError,
  editComment,
  listComments,
  setSocialEnabled,
  softDeleteComment,
} from "./social";

/**
 * Review PLAN-C9 and PLAN.md §9.4. Reports have existed since social shipped
 * and nothing read them — the finding is not that reports were missing, it is
 * that writing them was mistaken for handling them. These pin the queue that
 * reads them and the record it leaves behind.
 */
let db: DB;
let operator: schema.User;
let author: schema.User;
let reporter: schema.User;

async function profileFor(user: schema.User, handle: string) {
  await db.insert(schema.userProfiles).values({
    userId: user.id,
    handle,
    displayName: user.name,
    isPublic: true,
    socialEnabled: true,
  });
}

async function report(
  subjectType: schema.ReportSubjectType,
  subjectId: string,
  createdAt = new Date(),
  reporterId?: string,
): Promise<string> {
  const id = uid("report");
  await db.insert(schema.reports).values({
    id,
    subjectType,
    subjectId,
    reporterId: reporterId ?? reporter.id,
    reason: "abuse",
    createdAt,
  });
  return id;
}

/** The id of the hide currently in force — what the queue's Lift button sends. */
async function standingHideId(subjectType: "pour" | "comment", subjectId: string): Promise<string> {
  const { hides } = await listStandingHides(db);
  const hit = hides.find((h) => h.subjectType === subjectType && h.subjectId === subjectId);
  if (!hit) throw new Error(`no standing hide for ${subjectType} ${subjectId}`);
  return hit.actionId;
}

/** The suspension currently in force — what the queue's Reinstate button sends. */
async function standingSuspensionId(userId: string): Promise<string> {
  const { accounts } = await listSuspendedAccounts(db);
  const hit = accounts.find((a) => a.userId === userId);
  if (!hit?.suspensionId) throw new Error(`no standing suspension for ${userId}`);
  return hit.suspensionId;
}

beforeEach(async () => {
  db = await setupTestDb();
  operator = await createTestUser(db, { name: "Op" });
  author = await createTestUser(db, { name: "Author" });
  reporter = await createTestUser(db, { name: "Reporter" });
  await profileFor(author, "author");
  await profileFor(reporter, "reporter");
});

describe("the queue", () => {
  it("shows open reports oldest first, with their age", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    await report("profile", author.id, new Date("2026-09-01T12:00:00Z"));
    await report("profile", reporter.id, new Date("2026-09-04T06:00:00Z"));

    const rows = await listOpenReports(db, now);
    // Oldest first: a newest-first queue is one where the thing that has waited
    // longest is the thing nobody sees.
    expect(rows.map((r) => r.ageHours)).toEqual([72, 6]);
    expect(rows[0].reporterHandle).toBe("reporter");
  });

  it("counts what has breached the SLA", async () => {
    const now = new Date("2026-09-04T12:00:00Z");
    await report("profile", author.id, new Date("2026-09-01T11:00:00Z"));
    await report("profile", reporter.id, new Date("2026-09-04T11:00:00Z"));
    expect(await countBreachedReports(db, now)).toBe(1);
    expect(REPORT_SLA_HOURS).toBe(72);
  });

  it("previews the reported thing so it can be judged without leaving", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    await db.insert(schema.tastingNotes).values({ id: uid("note"), pourId, freeform: "something awful" });
    await report("pour", pourId);

    const [row] = await listOpenReports(db);
    expect(row.preview).toContain("something awful");
    expect(row.subjectOwnerId).toBe(author.id);
    expect(row.alreadyHidden).toBe(false);
  });

  /**
   * The whole point of a snapshot: editing the abuse away must not also edit
   * away the complaint. Without this the queue showed the current text, so a
   * reported user who rewrote their comment left the operator judging content
   * nobody had objected to.
   */
  it("keeps what was reported when the subject is edited afterwards", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body: "something awful" });

    await db.insert(schema.reports).values({
      id: uid("report"),
      subjectType: "comment",
      subjectId: commentId,
      reporterId: reporter.id,
      reason: "abuse",
      subjectSnapshot: await subjectPreview(db, "comment", commentId),
    });

    await db.update(schema.comments).set({ body: "lovely dram" }).where(eq(schema.comments.id, commentId));

    const [row] = await listOpenReports(db);
    expect(row.reportedPreview).toBe("something awful");
    expect(row.preview).toBe("lovely dram");
    expect(row.editedSinceReport).toBe(true);
  });

  it("does not call an unedited subject edited", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body: "still awful" });
    await db.insert(schema.reports).values({
      id: uid("report"),
      subjectType: "comment",
      subjectId: commentId,
      reporterId: reporter.id,
      reason: "abuse",
      subjectSnapshot: await subjectPreview(db, "comment", commentId),
    });

    const [row] = await listOpenReports(db);
    expect(row.editedSinceReport).toBe(false);
  });

  /**
   * Reports filed before snapshots existed have none, and an unknown is not a
   * difference — flagging every one of them "edited" would train the operator
   * to ignore the flag that matters.
   */
  it("does not flag a pre-snapshot report as edited", async () => {
    await report("profile", author.id);
    const [row] = await listOpenReports(db);
    expect(row.reportedPreview).toBeNull();
    expect(row.editedSinceReport).toBe(false);
  });

  /**
   * An account that stepped back of its own accord (US-11's "make everything
   * private") is not an actioned account. Reading `socialEnabled` here would
   * put a moderation label on somebody's privacy choice.
   */
  it("does not call a self-stepped-back profile already handled", async () => {
    await db
      .update(schema.userProfiles)
      .set({ socialEnabled: false })
      .where(eq(schema.userProfiles.userId, author.id));
    await report("profile", author.id);

    const [row] = await listOpenReports(db);
    expect(row.alreadyHidden).toBe(false);
    expect(row.subjectOwnerSuspended).toBe(false);
  });
});

describe("hiding", () => {
  it("takes a comment out of view without destroying it", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: reporter.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body: "no" });
    const reportId = await report("comment", commentId);

    await hideSubject(db, operator.id, "comment", commentId, { reportId, note: "abusive" });

    const [row] = await db.select().from(schema.comments).where(eq(schema.comments.id, commentId));
    expect(row.deletedAt).not.toBeNull();
    // The words are still there: hiding is not deletion, and an appeal needs
    // something to appeal about.
    expect(row.body).toBe("no");
    expect(await listOpenReports(db)).toHaveLength(0);
  });

  /**
   * A profile's only lever is `socialEnabled`, which lives in the account's
   * own settings. "Hiding" one would last until its owner found the toggle
   * they already have, while telling the operator they had acted — so the
   * action that does not stick is not offered at all.
   */
  it("refuses to hide a profile, because a profile is suspended or it is not", async () => {
    await expect(hideSubject(db, operator.id, "profile", author.id, {})).rejects.toBeInstanceOf(
      CannotHideProfileError,
    );
    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, author.id));
    expect(profile.socialEnabled).toBe(true);
    expect(await db.select().from(schema.moderationActions)).toHaveLength(0);
  });

  it("makes a reported pour private rather than deleting somebody's journal", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });

    await hideSubject(db, operator.id, "pour", pourId, {});
    const [row] = await db.select().from(schema.pours).where(eq(schema.pours.id, pourId));
    expect(row.visibility).toBe("private");
  });

  /**
   * A `/s/<code>` link is a second door, and `getPublicPourShare` opens it on
   * `revokedAt` alone — it never looks at the pour's visibility. Making the
   * pour private without revoking leaves exactly the content the operator hid
   * readable by anyone holding the URL.
   */
  it("revokes the share links that would still serve a hidden pour", async () => {
    const { createPourShare, getPublicPourShare } = await import("./pour-sharing");
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({
      id: pourId,
      userId: author.id,
      bottleId: bottle.id,
      visibility: "public",
    });
    const share = await createPourShare(db, author.id, pourId);
    expect(share).not.toBeNull();
    const code = share!.code;
    expect(await getPublicPourShare(db, code)).not.toBeNull();

    await hideSubject(db, operator.id, "pour", pourId, { note: "abusive" });

    expect(await getPublicPourShare(db, code)).toBeNull();
  });

  it("is idempotent, so two operators on one report don't collide", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: reporter.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body: "no" });

    await hideSubject(db, operator.id, "comment", commentId, {});
    await expect(hideSubject(db, operator.id, "comment", commentId, {})).resolves.toBeUndefined();
  });

  it("refuses an id with nothing behind it", async () => {
    await expect(hideSubject(db, operator.id, "pour", "nope", {})).rejects.toBeInstanceOf(
      UnknownSubjectError,
    );
  });
});

describe("suspension", () => {
  it("switches the social surfaces off and records why", async () => {
    await suspendAccount(db, operator.id, author.id, "repeated abuse");

    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, author.id));
    expect(profile.suspendedAt).not.toBeNull();
    expect(profile.suspendedReason).toBe("repeated abuse");
    expect(profile.socialEnabled).toBe(false);
    expect(profile.isPublic).toBe(false);
  });

  /**
   * The whole point. `socialEnabled` is a switch the account already has, so a
   * suspension that only flipped it would last as long as it took to find the
   * toggle.
   */
  it("cannot be lifted by the account it was applied to", async () => {
    await suspendAccount(db, operator.id, author.id, "repeated abuse");
    await expect(setSocialEnabled(db, author.id, true)).rejects.toBeInstanceOf(
      AccountSuspendedError,
    );
    // Turning social further off is always allowed — nothing here stops
    // somebody withdrawing.
    await expect(setSocialEnabled(db, author.id, false)).resolves.toBe(true);
  });

  it("lifts on reinstatement, and leaves the account to publish itself again", async () => {
    await suspendAccount(db, operator.id, author.id, "repeated abuse");
    await reinstateAccount(
      db,
      operator.id,
      author.id,
      "appealed successfully",
      await standingSuspensionId(author.id),
    );

    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, author.id));
    expect(profile.suspendedAt).toBeNull();
    // Deliberately still off: the system never raises a visibility.
    expect(profile.socialEnabled).toBe(false);
    await expect(setSocialEnabled(db, author.id, true)).resolves.toBe(true);
  });

  it("refuses an operator suspending themselves out of their own queue", async () => {
    await profileFor(operator, "operator");
    await expect(
      suspendAccount(db, operator.id, operator.id, "oops"),
    ).rejects.toBeInstanceOf(UnknownSubjectError);
  });
});

describe("the audit trail", () => {
  it("records every decision with its actor and reason", async () => {
    const reportId = await report("profile", author.id);
    await suspendAccount(db, operator.id, author.id, "repeated abuse", { reportId });

    const entries = await listModerationActions(db);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "suspend",
      subjectType: "profile",
      subjectId: author.id,
      note: "repeated abuse",
      actorName: "Op",
    });
  });

  it("records a dismissal too — a decision not to act is still a decision", async () => {
    const reportId = await report("profile", author.id);
    await dismissReport(db, operator.id, reportId, "not a violation");

    const [row] = await db.select().from(schema.reports).where(eq(schema.reports.id, reportId));
    expect(row.state).toBe("dismissed");
    const entries = await listModerationActions(db);
    expect(entries[0]).toMatchObject({ action: "dismiss", note: "not a violation" });
    expect(await listOpenReports(db)).toHaveLength(0);
  });

  /**
   * Every state change and its audit row in one transaction. Content hidden
   * with no record is a decision nobody can answer an appeal from.
   */
  it("writes no audit row when the action itself did not happen", async () => {
    await expect(hideSubject(db, operator.id, "pour", "no-such-pour", {})).rejects.toBeInstanceOf(
      UnknownSubjectError,
    );
    await expect(
      suspendAccount(db, operator.id, "no-such-user", "abuse"),
    ).rejects.toBeInstanceOf(UnknownSubjectError);
    await expect(
      reinstateAccount(db, operator.id, "no-such-user", undefined, new Date().toISOString()),
    ).rejects.toBeInstanceOf(UnknownSubjectError);
    expect(await db.select().from(schema.moderationActions)).toHaveLength(0);
  });

  it("will not dismiss the same report twice", async () => {
    const reportId = await report("profile", author.id);
    await dismissReport(db, operator.id, reportId, undefined);
    await expect(dismissReport(db, operator.id, reportId, undefined)).rejects.toBeInstanceOf(
      UnknownSubjectError,
    );
  });
});

describe("suspension", () => {
  /**
   * `makeEverythingPrivate` clears `phoneDiscoverable` because re-enabling
   * social must not silently make a stored number findable again. A suspension
   * that skipped it would hand the account back that exposure on reinstatement
   * without ever asking — every other flag it clears is one the account sets
   * again deliberately.
   */
  it("clears phone discovery, so coming back needs a fresh opt-in", async () => {
    await db
      .update(schema.userProfiles)
      .set({ phoneDiscoverable: true })
      .where(eq(schema.userProfiles.userId, author.id));

    await suspendAccount(db, operator.id, author.id, "repeated abuse");

    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, author.id));
    expect(profile.phoneDiscoverable).toBe(false);
  });

  /**
   * Suspending resolves the report, and a resolved report leaves the queue —
   * taking the only Reinstate control with it. Without a standing list, an
   * appeal arriving later through /support has nowhere to be acted on.
   */
  it("stays findable after its report is gone, so an appeal can be acted on", async () => {
    const reportId = await report("profile", author.id);
    await suspendAccount(db, operator.id, author.id, "repeated abuse", { reportId });
    expect(await listOpenReports(db)).toHaveLength(0);

    const { accounts: suspended } = await listSuspendedAccounts(db);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toMatchObject({ userId: author.id, reason: "repeated abuse" });

    await reinstateAccount(db, operator.id, author.id, "appeal upheld", await standingSuspensionId(author.id));
    expect((await listSuspendedAccounts(db)).accounts).toHaveLength(0);
  });

  /** A reason the account cannot read does not tell them what to appeal. */
  it("is readable by the account it is about, and by nobody through the shared shape", async () => {
    const { getOwnSuspension, getOwnProfile } = await import("./social");
    expect(await getOwnSuspension(db, author.id)).toBeNull();

    await suspendAccount(db, operator.id, author.id, "repeated abuse");

    expect(await getOwnSuspension(db, author.id)).toMatchObject({ reason: "repeated abuse" });
    expect(await getOwnSuspension(db, reporter.id)).toBeNull();
    // Not on the projection that reaches other people.
    const profile = await getOwnProfile(db, author.id);
    expect(profile && "suspendedReason" in profile).toBe(false);
  });
});

describe("a hide that sticks", () => {
  /**
   * Hiding a pour uses the visibility field, which is the owner's own control.
   * Without a hold, the operator hides it, the report closes, and the owner
   * puts it straight back — the same hole a profile "hide" had, answered here
   * by closing the door rather than removing the action.
   */
  it("cannot be undone by the pour's owner", async () => {
    const { updatePourVisibility, ModeratedError } = await import("./pours");
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({
      id: pourId,
      userId: author.id,
      bottleId: bottle.id,
      visibility: "public",
    });

    await hideSubject(db, operator.id, "pour", pourId, { note: "abusive" });
    expect(await isModerationHidden(db, "pour", pourId)).toBe(true);

    await expect(
      updatePourVisibility(db, author.id, pourId, "public"),
    ).rejects.toBeInstanceOf(ModeratedError);
    // Making it private is still theirs to do — nothing here traps a note.
    await expect(updatePourVisibility(db, author.id, pourId, "private")).resolves.toBeTruthy();
  });

  /**
   * Revoking the links that exist and leaving the mint open is a pause, not a
   * takedown: `getPublicPourShare` never consults visibility, so one press of
   * Share would serve the same content at a fresh code.
   */
  it("cannot be re-shared at a new code while it stands", async () => {
    const { createPourShare } = await import("./pour-sharing");
    const { ModeratedError } = await import("./pours");
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({
      id: pourId,
      userId: author.id,
      bottleId: bottle.id,
      visibility: "public",
    });

    await hideSubject(db, operator.id, "pour", pourId, { note: "abusive" });
    await expect(createPourShare(db, author.id, pourId)).rejects.toBeInstanceOf(ModeratedError);

    // And can be shared again once an operator lifts it.
    await unhideSubject(
      db,
      operator.id,
      "pour",
      pourId,
      "appeal upheld",
      await standingHideId("pour", pourId),
    );
    await expect(createPourShare(db, author.id, pourId)).resolves.toMatchObject({
      code: expect.any(String),
    });
  });

  it("is lifted by an operator, and then the owner decides again", async () => {
    const { updatePourVisibility } = await import("./pours");
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({
      id: pourId,
      userId: author.id,
      bottleId: bottle.id,
      visibility: "public",
    });
    await hideSubject(db, operator.id, "pour", pourId, { note: "abusive" });

    await unhideSubject(
      db,
      operator.id,
      "pour",
      pourId,
      "appeal upheld",
      await standingHideId("pour", pourId),
    );

    expect(await isModerationHidden(db, "pour", pourId)).toBe(false);
    // Lifting restores control, not visibility: the system never raises one.
    const [row] = await db.select().from(schema.pours).where(eq(schema.pours.id, pourId));
    expect(row.visibility).toBe("private");
    await expect(updatePourVisibility(db, author.id, pourId, "public")).resolves.toMatchObject({
      visibility: "public",
    });
  });

  /** A reason recorded only where operators can read it isn't a reason given. */
  it("tells the author what happened and why", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });

    expect(await moderationNoticeFor(db, "pour", pourId)).toBeNull();
    await hideSubject(db, operator.id, "pour", pourId, { note: "targets a named person" });
    expect(await moderationNoticeFor(db, "pour", pourId)).toMatchObject({
      action: "hide",
      reason: "targets a named person",
    });

    await unhideSubject(
      db,
      operator.id,
      "pour",
      pourId,
      undefined,
      await standingHideId("pour", pourId),
    );
    expect(await moderationNoticeFor(db, "pour", pourId)).toBeNull();
  });
});

describe("suspension is an account-wide reset", () => {
  /**
   * Turning the profile flags off does not reach a `/s/<code>` link:
   * `getPublicPourShare` authorises on `revokedAt` alone. A suspended account
   * with live links is suspended from the surfaces nobody was reading and not
   * from the URL somebody already has.
   */
  it("takes the account's pours private and revokes its bearer links", async () => {
    const { createPourShare, getPublicPourShare } = await import("./pour-sharing");
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({
      id: pourId,
      userId: author.id,
      bottleId: bottle.id,
      visibility: "public",
    });
    const share = await createPourShare(db, author.id, pourId);
    expect(share).not.toBeNull();

    await suspendAccount(db, operator.id, author.id, "repeated abuse");

    expect(await getPublicPourShare(db, share!.code)).toBeNull();
    const [row] = await db.select().from(schema.pours).where(eq(schema.pours.id, pourId));
    expect(row.visibility).toBe("private");
    const [prefs] = await db
      .select()
      .from(schema.userSocialPrefs)
      .where(eq(schema.userSocialPrefs.userId, author.id));
    expect(prefs.defaultPourVisibility).toBe("private");
  });

  /**
   * The report transition belongs in the same transaction as the action.
   * Resolved afterwards, a failed second write left content hidden and the
   * report open, and the retry recorded the action twice.
   */
  it("closes its report in the same transaction as the action", async () => {
    const reportId = await report("profile", author.id);
    await suspendAccount(db, operator.id, author.id, "repeated abuse", { reportId });

    const [row] = await db.select().from(schema.reports).where(eq(schema.reports.id, reportId));
    expect(row.state).toBe("resolved");
    expect(await listOpenReports(db)).toHaveLength(0);
    expect(await db.select().from(schema.moderationActions)).toHaveLength(1);
  });
});

describe("the queue is bounded", () => {
  /**
   * Abuse arrives in volume and each row costs another query or two to
   * describe. An unbounded read makes the page fail exactly when it is needed.
   */
  it("returns one page and counts the rest", async () => {
    for (let i = 0; i < 5; i += 1) {
      await report("profile", author.id, new Date(Date.UTC(2026, 8, 1, i)));
    }
    expect(await countOpenReports(db)).toBe(5);
    const page = await listOpenReports(db, new Date(), 2);
    expect(page).toHaveLength(2);
    // Oldest first, so a page is always the work most overdue.
    expect(page[0].createdAt.getTime()).toBeLessThan(page[1].createdAt.getTime());
  });
});

describe("a report is the claim on the action", () => {
  /**
   * Two stale tabs: one dismisses, one suspends. Ignoring the affected-row
   * count let the loser commit its suspension anyway, leaving a report shown
   * as dismissed with a suspension and two conflicting audit rows behind it.
   */
  it("refuses an action against a report somebody else already handled", async () => {
    const reportId = await report("profile", author.id);
    await dismissReport(db, operator.id, reportId, "not a violation");

    await expect(
      suspendAccount(db, operator.id, author.id, "repeated abuse", { reportId }),
    ).rejects.toBeInstanceOf(ReportAlreadyHandledError);

    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, author.id));
    expect(profile.suspendedAt).toBeNull();
    // One decision, one record.
    const actions = await db.select().from(schema.moderationActions);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("dismiss");
  });

  it("still acts when no report is named", async () => {
    await expect(
      suspendAccount(db, operator.id, author.id, "found another way"),
    ).resolves.toBeUndefined();
  });
});

describe("lifting a comment hide", () => {
  async function commentBy(userId: string, body: string) {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: reporter.id, bottleId: bottle.id });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId, body });
    return { pourId, commentId };
  }

  it("restores what the hide removed", async () => {
    const { commentId } = await commentBy(author.id, "no");
    await hideSubject(db, operator.id, "comment", commentId, { note: "abusive" });
    await unhideSubject(
      db,
      operator.id,
      "comment",
      commentId,
      "appeal upheld",
      await standingHideId("comment", commentId),
    );

    const [row] = await db.select().from(schema.comments).where(eq(schema.comments.id, commentId));
    expect(row.deletedAt).toBeNull();
  });

  /**
   * `applyHide` treats an already-deleted comment as a successful hide, which
   * it must so two operators on one report don't collide. That makes an
   * unconditional restore able to republish something its author deleted.
   */
  it("does not republish a comment its author had already deleted", async () => {
    const { commentId } = await commentBy(author.id, "changed my mind");
    const deletedByOwner = new Date("2026-09-01T00:00:00Z");
    await db
      .update(schema.comments)
      .set({ deletedAt: deletedByOwner })
      .where(eq(schema.comments.id, commentId));

    await hideSubject(db, operator.id, "comment", commentId, { note: "abusive" });
    await unhideSubject(
      db,
      operator.id,
      "comment",
      commentId,
      "appeal upheld",
      await standingHideId("comment", commentId),
    );

    const [row] = await db.select().from(schema.comments).where(eq(schema.comments.id, commentId));
    expect(row.deletedAt).toEqual(deletedByOwner);
  });

  /** A hidden comment is an anonymous tombstone; its author must still be told. */
  it("tells the comment's author, and nobody else", async () => {
    const { pourId, commentId } = await commentBy(author.id, "no");
    await hideSubject(db, operator.id, "comment", commentId, { note: "targets a named person" });

    const mine = await commentNoticesForAuthor(db, pourId, author.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].reason).toBe("targets a named person");
    expect(await commentNoticesForAuthor(db, pourId, reporter.id)).toHaveLength(0);
  });
});

describe("the audit trail's lift control", () => {
  /**
   * The trail is history: it holds hides that were lifted and hides a later
   * hide superseded. `unhideSubject` acts on the subject, so a lift offered on
   * an old row would take down the current decision.
   */
  it("marks only the hide currently in force", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });

    await hideSubject(db, operator.id, "pour", pourId, { note: "first" }, new Date(1_000));
    await unhideSubject(db, operator.id, "pour", pourId, "lifted", await standingHideId("pour", pourId), new Date(2_000));
    await hideSubject(db, operator.id, "pour", pourId, { note: "again" }, new Date(3_000));

    const entries = await listModerationActions(db);
    const standing = entries.filter((e) => e.standing);
    expect(standing).toHaveLength(1);
    expect(standing[0].note).toBe("again");
  });

  it("marks nothing standing once the hide is lifted", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });
    await hideSubject(db, operator.id, "pour", pourId, { note: "first" }, new Date(1_000));
    await unhideSubject(db, operator.id, "pour", pourId, "lifted", await standingHideId("pour", pourId), new Date(2_000));

    expect((await listModerationActions(db)).filter((e) => e.standing)).toHaveLength(0);
  });
});

describe("what \"already handled\" means", () => {
  /**
   * Reading the pour's own visibility let its owner disable the Hide button by
   * making it private themselves — no moderation action recorded, so nothing
   * stopped them republishing afterwards. Hiding your own content is not a way
   * round the mechanism that sticks.
   */
  it("is not satisfied by the owner making their own pour private", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({
      id: pourId,
      userId: author.id,
      bottleId: bottle.id,
      visibility: "private",
    });
    await report("pour", pourId);

    const [row] = await listOpenReports(db);
    expect(row.alreadyHidden).toBe(false);

    await hideSubject(db, operator.id, "pour", pourId, { note: "abusive" });
    const [after] = await listOpenReports(db);
    expect(after.alreadyHidden).toBe(true);
  });

  /**
   * Two reports on one comment used to append a second hide with a newer
   * timestamp while `deletedAt` kept the first one's — after which lifting
   * matched nothing, restored nothing, and cleared the notice anyway, leaving
   * an anonymous tombstone with no reason and no way back.
   */
  it("records one hide however many operators act on it", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: reporter.id, bottleId: bottle.id });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body: "no" });

    const first = await report("comment", commentId, new Date("2026-09-01T00:00:00Z"));
    await hideSubject(db, operator.id, "comment", commentId, { note: "abusive", reportId: first }, new Date(1_000));
    const second = await report("comment", commentId, new Date("2026-09-02T00:00:00Z"), operator.id);
    await hideSubject(db, operator.id, "comment", commentId, { note: "again", reportId: second }, new Date(5_000));

    // One decision, and the second reporter's report still closed.
    const hides = (await db.select().from(schema.moderationActions)).filter((a) => a.action === "hide");
    expect(hides).toHaveLength(1);
    expect(hides[0].note).toBe("abusive");
    expect(await listOpenReports(db)).toHaveLength(0);

    // And lifting still restores, because the timestamps still match.
    await unhideSubject(
      db,
      operator.id,
      "comment",
      commentId,
      "appeal upheld",
      await standingHideId("comment", commentId),
    );
    const [row] = await db.select().from(schema.comments).where(eq(schema.comments.id, commentId));
    expect(row.deletedAt).toBeNull();
  });
});

describe("acting on a stale view", () => {
  async function hiddenPour() {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });
    await hideSubject(db, operator.id, "pour", pourId, { note: "first" }, new Date(1_000));
    const [first] = await db.select().from(schema.moderationActions);
    return { pourId, firstActionId: first.id };
  }

  /**
   * A queue page is a snapshot. Between render and click another operator can
   * lift one hide and apply the next, and an unbound reversal would then
   * overturn a decision nobody reviewed.
   */
  it("refuses a lift aimed at a hide that is no longer the one in force", async () => {
    const { pourId, firstActionId } = await hiddenPour();
    await unhideSubject(db, operator.id, "pour", pourId, "lifted", await standingHideId("pour", pourId), new Date(2_000));
    await hideSubject(db, operator.id, "pour", pourId, { note: "again" }, new Date(3_000));

    await expect(
      unhideSubject(db, operator.id, "pour", pourId, "stale tab", firstActionId, new Date(4_000)),
    ).rejects.toBeInstanceOf(StaleModerationViewError);
    expect(await isModerationHidden(db, "pour", pourId)).toBe(true);
  });

  it("allows the lift when it names the hide that stands", async () => {
    const { pourId, firstActionId } = await hiddenPour();
    await unhideSubject(db, operator.id, "pour", pourId, "upheld", firstActionId, new Date(2_000));
    expect(await isModerationHidden(db, "pour", pourId)).toBe(false);
  });

  it("refuses a reinstatement aimed at a suspension that has been replaced", async () => {
    await suspendAccount(db, operator.id, author.id, "first", {}, new Date(1_000));
    const stale = await standingSuspensionId(author.id);
    await reinstateAccount(db, operator.id, author.id, "lifted", stale, {}, new Date(2_000));
    await suspendAccount(db, operator.id, author.id, "again", {}, new Date(3_000));

    await expect(
      reinstateAccount(db, operator.id, author.id, "stale tab", stale, {}, new Date(4_000)),
    ).rejects.toBeInstanceOf(StaleModerationViewError);
    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, author.id));
    expect(profile.suspendedAt).not.toBeNull();
  });
});

describe("what moderation is holding, on a page its owner always has", () => {
  /**
   * The per-object notice lives on the pour a comment was left under, and that
   * pour can go private or its author can switch social off — after which the
   * only place the reason existed is unreachable by the person it is for.
   */
  /**
   * Walking the account's pours and asking about each is one query per pour on
   * every /sharing load, for an account that almost always has none. The work
   * has to scale with how much moderation touched them, not with how much they
   * have written.
   */
  it("costs nothing extra for an account with a long journal and no holds", async () => {
    const bottle = await createTestBottle(db);
    for (let i = 0; i < 40; i += 1) {
      await db.insert(schema.pours).values({ id: uid("pour"), userId: author.id, bottleId: bottle.id });
    }
    expect(await listOwnModerationHolds(db, author.id)).toEqual([]);
  });

  it("lists this user's held pours and comments, and nobody else's", async () => {
    const bottle = await createTestBottle(db);
    const myPour = uid("pour");
    await db.insert(schema.pours).values({ id: myPour, userId: author.id, bottleId: bottle.id });
    const theirPour = uid("pour");
    await db.insert(schema.pours).values({ id: theirPour, userId: reporter.id, bottleId: bottle.id });
    const myComment = uid("comment");
    await db
      .insert(schema.comments)
      .values({ id: myComment, pourId: theirPour, userId: author.id, body: "no" });

    await hideSubject(db, operator.id, "pour", myPour, { note: "note reason" });
    await hideSubject(db, operator.id, "comment", myComment, { note: "comment reason" });
    await hideSubject(db, operator.id, "pour", theirPour, { note: "not mine" });

    const mine = await listOwnModerationHolds(db, author.id);
    expect(mine.map((h) => h.reason).sort()).toEqual(["comment reason", "note reason"]);
    expect(mine.find((h) => h.subjectType === "comment")?.preview).toBe("no");

    const theirs = await listOwnModerationHolds(db, reporter.id);
    expect(theirs.map((h) => h.reason)).toEqual(["not mine"]);
  });

  it("drops a hold once it is lifted", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });
    await hideSubject(db, operator.id, "pour", pourId, { note: "reason" }, new Date(1_000));
    expect(await listOwnModerationHolds(db, author.id)).toHaveLength(1);

    const [action] = await db.select().from(schema.moderationActions);
    await unhideSubject(db, operator.id, "pour", pourId, "upheld", action.id, new Date(2_000));
    expect(await listOwnModerationHolds(db, author.id)).toHaveLength(0);
  });
});

describe("standing hides outlive the history window", () => {
  /**
   * `listModerationActions` is bounded history. A hide older than its window
   * would fall off the only list carrying a lift control, so an appeal about
   * something taken down months ago had no answer available in the product.
   */
  it("lists a hide the recent-actions window no longer reaches", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });
    await hideSubject(db, operator.id, "pour", pourId, { note: "old hide" }, new Date(1_000));

    // Push it past a small history window with unrelated decisions.
    for (let i = 0; i < 5; i += 1) {
      const rid = await report("profile", author.id, new Date(2_000 + i));
      await dismissReport(db, operator.id, rid, `later ${i}`, new Date(10_000 + i));
    }

    const recent = await listModerationActions(db, 3);
    expect(recent.some((e) => e.note === "old hide")).toBe(false);

    const { hides: standing } = await listStandingHides(db);
    expect(standing).toHaveLength(1);
    expect(standing[0]).toMatchObject({ subjectType: "pour", subjectId: pourId, note: "old hide" });
    expect(standing[0].actorName).toBe("Op");
  });

  it("drops one as soon as it is lifted", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });
    await hideSubject(db, operator.id, "pour", pourId, { note: "reason" }, new Date(1_000));
    const { hides: standingNow } = await listStandingHides(db);
    const actionId = standingNow[0].actionId;

    await unhideSubject(db, operator.id, "pour", pourId, "upheld", actionId, new Date(2_000));
    expect((await listStandingHides(db)).hides).toHaveLength(0);
  });
});

describe("a report only claims the action it is about", () => {
  /**
   * Claiming by id alone let a malformed request hide subject B while closing
   * a report about subject A — and file an audit row tying B's takedown to A's
   * report, which is the trail lying about why something happened.
   */
  it("refuses a hide that cites somebody else's report", async () => {
    const bottle = await createTestBottle(db);
    const reported = uid("pour");
    const other = uid("pour");
    await db.insert(schema.pours).values([
      { id: reported, userId: author.id, bottleId: bottle.id },
      { id: other, userId: author.id, bottleId: bottle.id },
    ]);
    const reportId = await report("pour", reported);

    await expect(
      hideSubject(db, operator.id, "pour", other, { note: "abusive", reportId }),
    ).rejects.toBeInstanceOf(ReportSubjectMismatchError);

    expect(await isModerationHidden(db, "pour", other)).toBe(false);
    expect(await db.select().from(schema.moderationActions)).toHaveLength(0);
    expect(await listOpenReports(db)).toHaveLength(1);
  });

  it("refuses a suspension that cites a report about somebody else", async () => {
    const reportId = await report("profile", reporter.id);
    await expect(
      suspendAccount(db, operator.id, author.id, "abuse", { reportId }),
    ).rejects.toBeInstanceOf(ReportSubjectMismatchError);

    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, author.id));
    expect(profile.suspendedAt).toBeNull();
  });

  /** A report about their comment is a claim on suspending its author. */
  it("accepts a suspension cited against a report about that account's content", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: reporter.id, bottleId: bottle.id });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body: "no" });
    const reportId = await report("comment", commentId);

    await expect(
      suspendAccount(db, operator.id, author.id, "repeated abuse", { reportId }),
    ).resolves.toBeUndefined();
    expect(await listOpenReports(db)).toHaveLength(0);
  });
});

describe("standing hides are paged, not capped", () => {
  /**
   * A cap is the audit-window bug one level out: past it, the oldest takedowns
   * lose the only control that lifts them.
   */
  it("hands back a cursor and the newer page follows it, oldest first", async () => {
    const bottle = await createTestBottle(db);
    for (let i = 0; i < 3; i += 1) {
      const pourId = uid("pour");
      await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });
      await hideSubject(db, operator.id, "pour", pourId, { note: `hide ${i}` }, new Date(1_000 + i));
    }

    // Oldest first: binding STORYBOARD §3.17 pages both standing lists
    // oldest-cursor-first, because the decision nobody has looked at in months
    // is the one that must not be page five on the only screen that lifts it.
    const first = await listStandingHides(db, { limit: 2 });
    expect(first.hides.map((h) => h.note)).toEqual(["hide 0", "hide 1"]);
    expect(first.nextCursor).not.toBeNull();

    const next = await listStandingHides(db, { limit: 2, after: Number(first.nextCursor) });
    expect(next.hides.map((h) => h.note)).toEqual(["hide 2"]);
    expect(next.nextCursor).toBeNull();
  });

  /**
   * A timestamp-only cursor drops every row sharing the boundary instant: they
   * are on neither page, and a hide lost in that gap loses the only control
   * that lifts it. Two hides in one millisecond is a script, or one operator
   * working quickly.
   */
  it("does not lose hides that share the boundary timestamp", async () => {
    const bottle = await createTestBottle(db);
    const sameInstant = new Date(5_000);
    for (let i = 0; i < 4; i += 1) {
      const pourId = uid("pour");
      await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });
      await hideSubject(db, operator.id, "pour", pourId, { note: `tied ${i}` }, sameInstant);
    }

    const seen: string[] = [];
    let after: number | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = await listStandingHides(db, { limit: 2, after });
      seen.push(...result.hides.map((h) => h.note!));
      if (!result.nextCursor) break;
      after = Number(result.nextCursor);
    }
    expect(seen.sort()).toEqual(["tied 0", "tied 1", "tied 2", "tied 3"]);
  });
});

describe("suspended accounts are paged too", () => {
  /**
   * This list carries the only reinstate control in the product, so anything
   * that falls off it is an account nobody can bring back — the same reasoning
   * as the standing hides, and the same compound cursor.
   */
  it("hands back a cursor and does not lose accounts sharing a timestamp", async () => {
    const sameInstant = new Date(9_000);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const u = await createTestUser(db, { name: `Sus ${i}` });
      await profileFor(u, `sus${i}`);
      await suspendAccount(db, operator.id, u.id, `reason ${i}`, {}, sameInstant);
      ids.push(u.id);
    }

    const seen: string[] = [];
    let after: { at: Date; userId: string } | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = await listSuspendedAccounts(db, { limit: 2, after });
      seen.push(...result.accounts.map((a) => a.userId));
      if (!result.nextCursor) break;
      const cut = result.nextCursor.lastIndexOf("|");
      after = {
        at: new Date(result.nextCursor.slice(0, cut)),
        userId: result.nextCursor.slice(cut + 1),
      };
    }
    expect(seen.sort()).toEqual(ids.sort());
  });
});

describe("decision order, not clock order", () => {
  /**
   * Two actions can share a millisecond, and a request that captured its
   * timestamp before waiting on the moderation lock commits after one that
   * captured a later one. Ordering by `(createdAt, id)` disambiguated the rows
   * without preserving their order — the id is a random UUID — so a freshly
   * hidden pour could read as lifted, or a lifted one keep blocking its owner.
   */
  it("reads the current state right when two actions share a timestamp", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });
    const sameInstant = new Date(7_000);

    await hideSubject(db, operator.id, "pour", pourId, { note: "hidden" }, sameInstant);
    expect(await isModerationHidden(db, "pour", pourId)).toBe(true);

    await unhideSubject(
      db,
      operator.id,
      "pour",
      pourId,
      "lifted",
      await standingHideId("pour", pourId),
      sameInstant,
    );
    expect(await isModerationHidden(db, "pour", pourId)).toBe(false);
    expect((await listStandingHides(db)).hides).toHaveLength(0);
    expect(await moderationNoticeFor(db, "pour", pourId)).toBeNull();

    await hideSubject(db, operator.id, "pour", pourId, { note: "again" }, sameInstant);
    expect(await isModerationHidden(db, "pour", pourId)).toBe(true);
    expect((await listStandingHides(db)).hides[0].note).toBe("again");
    // And the audit list agrees about which entry is in force.
    const standing = (await listModerationActions(db)).filter((e) => e.standing);
    expect(standing).toHaveLength(1);
    expect(standing[0].note).toBe("again");
  });

  /** An earlier-stamped action committing later must not win. */
  it("is not fooled by a later action carrying an earlier timestamp", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id });

    await hideSubject(db, operator.id, "pour", pourId, { note: "hidden" }, new Date(9_000));
    await unhideSubject(
      db,
      operator.id,
      "pour",
      pourId,
      "lifted",
      await standingHideId("pour", pourId),
      // Stamped before the hide it reverses, as a request that waited on the
      // lock would be.
      new Date(1_000),
    );

    expect(await isModerationHidden(db, "pour", pourId)).toBe(false);
  });
});

/**
 * A schema that refuses to delete an operator is a schema that revokes their
 * deletion right, and the two obvious escapes — erase the history, or reassign
 * its actor to somebody who did not decide it — both destroy the trail. So the
 * actor goes and the decision stays.
 */
describe("an operator can be deleted without taking the trail with them", () => {
  it("keeps the decision, its reason and its standing hide", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    await hideSubject(db, operator.id, "pour", pourId, { note: "graphic" });

    await db.delete(schema.user).where(eq(schema.user.id, operator.id));

    const actions = await listModerationActions(db, 10);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("hide");
    expect(actions[0].note).toBe("graphic");
    // Null means "the operator's account is gone", not "nobody acted".
    expect(actions[0].actorName).toBeNull();

    // And the hide is still liftable: this list carries the only control that
    // lifts one, so losing the row would strand the pour hidden forever.
    const { hides } = await listStandingHides(db);
    expect(hides.map((h) => h.subjectId)).toEqual([pourId]);
    expect(await isModerationHidden(db, "pour", pourId)).toBe(true);
  });
});

/**
 * Deleting the reported thing must not delete the account's answer for it.
 * `deletePour` is a hard delete, so without the owner recorded on the report
 * the queue lost the Suspend control the moment the author removed the
 * evidence — moderation reachable only while the subject cooperated.
 */
describe("a deleted subject does not take its author out of reach", () => {
  it("keeps the recorded owner, and the report, after the pour is gone", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    await db.insert(schema.tastingNotes).values({ id: uid("note"), pourId, freeform: "something awful" });

    await db.insert(schema.reports).values({
      id: uid("report"),
      subjectType: "pour",
      subjectId: pourId,
      reporterId: reporter.id,
      reason: "abuse",
      subjectOwnerId: author.id,
      subjectSnapshot: await subjectPreview(db, "pour", pourId),
    });

    await db.delete(schema.pours).where(eq(schema.pours.id, pourId));

    const [row] = await listOpenReports(db);
    // The content is gone; what it said and who posted it are not.
    expect(row.preview).toBeNull();
    expect(row.reportedPreview).toContain("something awful");
    expect(row.subjectOwnerId).toBe(author.id);
    expect(row.subjectOwnerSuspended).toBe(false);

    // And the account-level action still works, which is the whole point.
    await suspendAccount(db, operator.id, author.id, "repeated abuse", { reportId: row.id });
    const after = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, author.id),
    });
    expect(after?.suspendedAt).not.toBeNull();
  });

  it("reports a recorded owner as suspended once they are", async () => {
    await suspendAccount(db, operator.id, author.id, "abuse");
    await db.insert(schema.reports).values({
      id: uid("report"),
      subjectType: "pour",
      subjectId: uid("gone"),
      reporterId: reporter.id,
      reason: "abuse",
      subjectOwnerId: author.id,
    });
    const [row] = await listOpenReports(db);
    // Otherwise the queue offers Suspend on an account that already is.
    expect(row.subjectOwnerSuspended).toBe(true);
  });
});

/**
 * The preview is not a preview — it is the only view. There is no expansion
 * control and deliberately no link to the content, so a 500-character cap put
 * anything after it beyond the operator's reach: a comment runs to 1,000
 * characters and a tasting note to 11,000.
 */
describe("the operator sees the whole reported text", () => {
  it("does not truncate a long comment", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const body = `${"a".repeat(900)}THE-ABUSIVE-PART`;
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body });

    expect(await subjectPreview(db, "comment", commentId)).toContain("THE-ABUSIVE-PART");
  });

  it("does not truncate a long tasting note", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    await db
      .insert(schema.tastingNotes)
      .values({ id: uid("note"), pourId, freeform: `${"b".repeat(900)}THE-ABUSIVE-PART` });

    expect(await subjectPreview(db, "pour", pourId)).toContain("THE-ABUSIVE-PART");
  });
});

/**
 * Several people reporting one comment is the normal case, and the second
 * report is genuinely handled by the hide already in force. `hideSubject` was
 * built for it; the queue just needs to be able to reach that path.
 */
describe("a second report on an already-hidden subject", () => {
  it("resolves through hide without recording a second action", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body: "no" });

    const first = await report("comment", commentId);
    const second = await report("comment", commentId, new Date(), author.id);

    await hideSubject(db, operator.id, "comment", commentId, { reportId: first, note: "abuse" });
    await hideSubject(db, operator.id, "comment", commentId, { reportId: second, note: "same abuse" });

    // Both reports handled...
    expect(await countOpenReports(db)).toBe(0);
    // ...by one hide. A second would orphan the first's `deletedAt` and make
    // lifting restore nothing.
    const actions = await listModerationActions(db, 10);
    expect(actions.filter((a) => a.action === "hide")).toHaveLength(1);
  });
});

/**
 * The third time a timestamp was asked to be an identity. `suspendAccount`
 * captures `now` before it waits on the lock and overwrites `suspendedAt`, so
 * two suspensions can carry the same millisecond while differing in reason and
 * in the decision recorded — and the old guard, which compared timestamps,
 * let a page showing the first lift the second.
 */
describe("reinstatement names a decision, not a moment", () => {
  it("refuses a guard from a superseded suspension sharing its timestamp", async () => {
    // A suspension over a standing one now records nothing, so the collision
    // has to be built the way it can still occur: lift, then suspend again at
    // the identical timestamp. Two genuinely distinct decisions, one moment.
    const sameMoment = new Date("2026-09-04T12:00:00.000Z");
    await suspendAccount(db, operator.id, author.id, "first reason", {}, sameMoment);
    const stale = await standingSuspensionId(author.id);
    await reinstateAccount(db, operator.id, author.id, "lifted", stale, {}, sameMoment);
    await suspendAccount(db, operator.id, author.id, "second reason", {}, sameMoment);

    const current = await standingSuspensionId(author.id);
    expect(current).not.toBe(stale);
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, author.id),
    });
    // Same millisecond, different decision — which is the whole point.
    expect(profile?.suspendedAt?.toISOString()).toBe(sameMoment.toISOString());
    expect(profile?.suspendedReason).toBe("second reason");

    // The old timestamp guard could not tell these apart. The action id can.
    await expect(
      reinstateAccount(db, operator.id, author.id, "stale tab", stale),
    ).rejects.toBeInstanceOf(StaleModerationViewError);

    const after = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, author.id),
    });
    expect(after?.suspendedAt).not.toBeNull();

    await reinstateAccount(db, operator.id, author.id, "appeal upheld", current);
    const lifted = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, author.id),
    });
    expect(lifted?.suspendedAt).toBeNull();
  });
});

/**
 * The profile-shaped version of the already-hidden finding, and the lock hole
 * underneath it.
 */
describe("a second report about an already-suspended account", () => {
  it("resolves through suspend without replacing the standing decision", async () => {
    const first = await report("profile", author.id);
    const second = await report("profile", author.id, new Date(), author.id);

    await suspendAccount(db, operator.id, author.id, "first reason", { reportId: first });
    const standing = await standingSuspensionId(author.id);

    await suspendAccount(db, operator.id, author.id, "second reason", { reportId: second });

    // Both reports handled, and the queue has nothing left to dismiss falsely.
    expect(await countOpenReports(db)).toBe(0);
    // By one decision. Overwriting would lose the reason the account was told
    // and leave two rival `suspend` rows describing one state.
    expect(await standingSuspensionId(author.id)).toBe(standing);
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, author.id),
    });
    expect(profile?.suspendedReason).toBe("first reason");
    expect(
      (await listModerationActions(db, 10)).filter((a) => a.action === "suspend"),
    ).toHaveLength(1);
  });

  it("takes both locks, so a stale reinstatement cannot outrun a suspension", async () => {
    // The guard is only as good as the lock the decision it names is read
    // under: suspension held `social-reset` and reinstatement held
    // `moderation:profile`, so neither excluded the other and a reinstatement
    // could validate one suspension and clear the next.
    await suspendAccount(db, operator.id, author.id, "first", {}, new Date(1_000));
    const stale = await standingSuspensionId(author.id);
    await reinstateAccount(db, operator.id, author.id, "lifted", stale, {}, new Date(2_000));
    await suspendAccount(db, operator.id, author.id, "second", {}, new Date(3_000));

    await expect(
      reinstateAccount(db, operator.id, author.id, "stale tab", stale, {}, new Date(4_000)),
    ).rejects.toBeInstanceOf(StaleModerationViewError);
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, author.id),
    });
    expect(profile?.suspendedAt).not.toBeNull();
    expect(profile?.suspendedReason).toBe("second");
  });
});

/**
 * The deleted-subject hole, one branch over from the Suspend one. A standing
 * hide is proof the subject existed, so refusing to resolve a later report
 * because the pour has since been deleted refuses on the wrong grounds — and
 * it strands exactly the ordinary case: several reports, first one hidden,
 * owner deletes the pour, rest stuck behind a button that throws.
 */
describe("a hidden subject that is then deleted", () => {
  it("still resolves the reports it left open", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const first = await report("pour", pourId);
    const second = await report("pour", pourId, new Date(), author.id);

    await hideSubject(db, operator.id, "pour", pourId, { reportId: first, note: "graphic" });
    await db.delete(schema.pours).where(eq(schema.pours.id, pourId));

    // The queue still offers "Resolve as hidden" here, because the hide stands.
    await hideSubject(db, operator.id, "pour", pourId, { reportId: second, note: "same" });
    expect(await countOpenReports(db)).toBe(0);
    // And still exactly one hide: the second records nothing.
    expect(
      (await listModerationActions(db, 10)).filter((a) => a.action === "hide"),
    ).toHaveLength(1);
  });

  it("still refuses a hide on a subject that was never there", async () => {
    // No report claims it, so nothing says the subject was ever real.
    await expect(
      hideSubject(db, operator.id, "pour", uid("ghost"), { note: "nope" }),
    ).rejects.toBeInstanceOf(UnknownSubjectError);
  });

  /**
   * The same stranding one step earlier: no hide has been recorded yet, so the
   * already-hidden branch above does not apply and the first Hide threw. The
   * operator was left able only to dismiss a valid complaint as unfounded or
   * to suspend the account — a heavier decision reached for because the
   * lighter one errored.
   */
  it("resolves a report whose subject was deleted before any hide", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const reportId = await report("pour", pourId);

    await db.delete(schema.pours).where(eq(schema.pours.id, pourId));

    await hideSubject(db, operator.id, "pour", pourId, { reportId, note: "already gone" });
    expect(await countOpenReports(db)).toBe(0);
    const hides = (await listModerationActions(db, 10)).filter((a) => a.action === "hide");
    expect(hides).toHaveLength(1);
    expect(hides[0].note).toBe("already gone");
  });

  it("will not let a report close over a subject it is not about", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const reportId = await report("pour", pourId);

    // A real, open report — but named alongside a subject it says nothing
    // about. The report row is what proves a subject existed, so it has to be
    // the report's own subject.
    await expect(
      hideSubject(db, operator.id, "pour", uid("ghost"), { reportId, note: "nope" }),
    ).rejects.toBeInstanceOf(ReportSubjectMismatchError);
    expect(await countOpenReports(db)).toBe(1);
    expect(await listModerationActions(db, 10)).toHaveLength(0);
  });

  it("drops a hide whose subject is gone off the standing list", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    await hideSubject(db, operator.id, "pour", pourId, { note: "graphic" });
    expect((await listStandingHides(db)).hides).toHaveLength(1);

    await db.delete(schema.pours).where(eq(schema.pours.id, pourId));

    // This list carries the only control that lifts a hide, so a row whose
    // subject is gone is a button that can do nothing.
    expect((await listStandingHides(db)).hides).toHaveLength(0);
  });
});

/**
 * STORYBOARD §3.17 is binding: "An operator can hide a thing and suspend an
 * account; they cannot read what was never shared." The report-time snapshot
 * is always fair game — the reporter saw it, and it is what the decision is
 * judged on. A revision written *after* the content went private is not: no
 * reporter could ever have seen it, and no complaint is about it.
 */
describe("the queue does not show what was never shared", () => {
  async function reportedComment(body: string) {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body });
    await db.insert(schema.reports).values({
      id: uid("report"),
      subjectType: "comment",
      subjectId: commentId,
      reporterId: reporter.id,
      reason: "abuse",
      subjectOwnerId: author.id,
      subjectSnapshot: await subjectPreview(db, "comment", commentId),
    });
    return { pourId, commentId };
  }

  it("withholds a revision made after the pour went private", async () => {
    const { pourId, commentId } = await reportedComment("something awful");

    await db
      .update(schema.pours)
      .set({ visibility: "private" })
      .where(eq(schema.pours.id, pourId));
    await db
      .update(schema.comments)
      .set({ body: "PRIVATE-REVISION" })
      .where(eq(schema.comments.id, commentId));

    const [row] = await listOpenReports(db);
    expect(row.reportedPreview).toBe("something awful");
    expect(row.preview).toBeNull();
    expect(row.liveReadable).toBe(false);
    // And not flagged edited: an unknown is not a difference.
    expect(row.editedSinceReport).toBe(false);
  });

  it("withholds it when the author steps back instead", async () => {
    const { commentId } = await reportedComment("something awful");
    await db
      .update(schema.userProfiles)
      .set({ socialEnabled: false })
      .where(eq(schema.userProfiles.userId, author.id));
    await db
      .update(schema.comments)
      .set({ body: "PRIVATE-REVISION" })
      .where(eq(schema.comments.id, commentId));

    const [row] = await listOpenReports(db);
    expect(row.preview).toBeNull();
    expect(row.liveReadable).toBe(false);
  });

  /**
   * The pour's owner is not necessarily the comment's author, and
   * `canViewPourContext` keys on the *pour author's* switch before it looks at
   * the tier at all. The first version of this gate checked only the comment
   * author's, so a comment under a withdrawn pour stayed readable.
   */
  it("withholds a comment whose pour owner stepped back, not just its author", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    // The pour belongs to `reporter`; the comment on it is by `author`.
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: reporter.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db
      .insert(schema.comments)
      .values({ id: commentId, pourId, userId: author.id, body: "something awful" });
    await db.insert(schema.reports).values({
      id: uid("report"),
      subjectType: "comment",
      subjectId: commentId,
      reporterId: reporter.id,
      reason: "abuse",
      subjectOwnerId: author.id,
      subjectSnapshot: await subjectPreview(db, "comment", commentId),
    });

    // The pour's OWNER steps back. The comment's author is untouched, and the
    // pour's visibility column still says "public".
    await db
      .update(schema.userProfiles)
      .set({ socialEnabled: false })
      .where(eq(schema.userProfiles.userId, reporter.id));
    await db
      .update(schema.comments)
      .set({ body: "PRIVATE-REVISION" })
      .where(eq(schema.comments.id, commentId));

    const [row] = await listOpenReports(db);
    expect(row.reportedPreview).toBe("something awful");
    expect(row.liveReadable).toBe(false);
    expect(row.preview).toBeNull();
    expect(row.editedSinceReport).toBe(false);
  });

  /**
   * `canViewPourContext` does not stop at the visibility string for the
   * friends and followers tiers — it requires a mutual friendship or an
   * accepted follow. A friends-only pour whose owner has no friends is shared
   * with nobody, however "friends" its visibility column reads.
   */
  it("withholds a friends-tier pour with nobody in the tier", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "friends" });
    await db.insert(schema.tastingNotes).values({ id: uid("note"), pourId, freeform: "something awful" });
    await db.insert(schema.reports).values({
      id: uid("report"),
      subjectType: "pour",
      subjectId: pourId,
      reporterId: reporter.id,
      reason: "abuse",
      subjectOwnerId: author.id,
      subjectSnapshot: await subjectPreview(db, "pour", pourId),
    });

    const [withoutFriends] = await listOpenReports(db);
    expect(withoutFriends.liveReadable).toBe(false);
    expect(withoutFriends.preview).toBeNull();

    // Give the owner a mutual follow and the tier has an audience again.
    await db.insert(schema.follows).values([
      { id: uid("f"), followerId: reporter.id, followeeId: author.id, state: "accepted" },
      { id: uid("f"), followerId: author.id, followeeId: reporter.id, state: "accepted" },
    ]);
    const [withFriends] = await listOpenReports(db);
    expect(withFriends.liveReadable).toBe(true);
    expect(withFriends.preview).toContain("something awful");
  });

  /**
   * The pour's tier having members is not enough: `listComments` skips a
   * comment for any viewer blocked either way with its author, so a comment
   * whose author has blocked every friend of the pour owner is readable by
   * nobody even though the pour is shared.
   */
  it("withholds a comment whose author has blocked the whole audience", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    // reporter owns a friends-tier pour; reporter and author are friends, so
    // the tier is not empty.
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: reporter.id, bottleId: bottle.id, visibility: "friends" });
    await db.insert(schema.follows).values([
      { id: uid("f"), followerId: reporter.id, followeeId: author.id, state: "accepted" },
      { id: uid("f"), followerId: author.id, followeeId: reporter.id, state: "accepted" },
    ]);
    const commentId = uid("comment");
    await db
      .insert(schema.comments)
      .values({ id: commentId, pourId, userId: author.id, body: "something awful" });
    await db.insert(schema.reports).values({
      id: uid("report"),
      subjectType: "comment",
      subjectId: commentId,
      reporterId: reporter.id,
      reason: "abuse",
      subjectOwnerId: author.id,
      subjectSnapshot: await subjectPreview(db, "comment", commentId),
    });

    // The only member of the tier is the pour owner, and the comment's author
    // has blocked them — so nobody can read the comment.
    await db
      .insert(schema.blocks)
      .values({ id: uid("b"), blockerId: author.id, blockedId: reporter.id });
    await db
      .update(schema.comments)
      .set({ body: "PRIVATE-REVISION" })
      .where(eq(schema.comments.id, commentId));

    const [row] = await listOpenReports(db);
    expect(row.reportedPreview).toBe("something awful");
    expect(row.liveReadable).toBe(false);
    expect(row.preview).toBeNull();
  });

  it("still shows the current text while the subject is public", async () => {
    const { commentId } = await reportedComment("something awful");
    await db
      .update(schema.comments)
      .set({ body: "lovely dram" })
      .where(eq(schema.comments.id, commentId));

    const [row] = await listOpenReports(db);
    expect(row.liveReadable).toBe(true);
    expect(row.preview).toBe("lovely dram");
    expect(row.editedSinceReport).toBe(true);
  });
});

/**
 * A suspension is not a takedown. Hide and Suspend were mutually exclusive per
 * report — whichever the operator clicked resolved it and took the row, and
 * the row was the only place the subject's id appeared — so suspending left
 * the reported comment in place, hidden only by the author's suspended
 * `socialEnabled`, and a reinstatement plus their own re-enable published it
 * again.
 */
describe("suspending takes the reported content down with the account", () => {
  async function reportedComment() {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body: "abuse" });
    return { commentId, reportId: await report("comment", commentId) };
  }

  it("hides the comment in the same transaction, and the hide outlives reinstatement", async () => {
    const { commentId, reportId } = await reportedComment();

    await suspendAccount(db, operator.id, author.id, "repeated abuse", { reportId });

    expect(await isModerationHidden(db, "comment", commentId)).toBe(true);
    expect(await countOpenReports(db)).toBe(0);

    // Reinstating the account does not republish the content: the hide is a
    // separate decision and only an operator lifts it.
    await reinstateAccount(db, operator.id, author.id, "appeal upheld", await standingSuspensionId(author.id));
    expect(await isModerationHidden(db, "comment", commentId)).toBe(true);
    const row = await db.query.comments.findFirst({ where: eq(schema.comments.id, commentId) });
    expect(row?.deletedAt).not.toBeNull();
  });

  /**
   * The queue's "Reinstate author" is offered on any open report whose subject
   * owner is suspended — which is normally a *second* report, the first having
   * been resolved by the suspension itself. Sent without the report id it lifted
   * the suspension and left that complaint open, and the row then rendered with
   * no Reinstate control at all (the author is no longer suspended), so closing
   * it needed a second, unrelated Dismiss or Suspend.
   */
  it("reinstating from an open report resolves that report and names it in the trail", async () => {
    const first = await reportedComment();
    const second = await reportedComment();

    await suspendAccount(db, operator.id, author.id, "abuse", { reportId: first.reportId });
    // The second is about a different comment, so the suspension leaves it open.
    expect(await countOpenReports(db)).toBe(1);

    await reinstateAccount(
      db,
      operator.id,
      author.id,
      "appeal upheld",
      await standingSuspensionId(author.id),
      { reportId: second.reportId },
    );

    const row = await db.query.reports.findFirst({
      where: eq(schema.reports.id, second.reportId),
    });
    expect(row?.state).toBe("resolved");
    expect(await countOpenReports(db)).toBe(0);

    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, author.id),
    });
    expect(profile?.suspendedAt).toBeNull();

    // And the trail says which complaint the lift answered.
    const lifts = await db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.action, "reinstate"));
    expect(lifts).toHaveLength(1);
    expect(lifts[0].reportId).toBe(second.reportId);
  });

  it("refuses to close a report about somebody else's content with this lift", async () => {
    const mine = await reportedComment();
    // A report whose subject belongs to a different account entirely.
    const otherPourId = uid("pour");
    const bottle = await createTestBottle(db);
    await db
      .insert(schema.pours)
      .values({ id: otherPourId, userId: reporter.id, bottleId: bottle.id, visibility: "public" });
    const foreign = await report("pour", otherPourId);

    await suspendAccount(db, operator.id, author.id, "abuse", { reportId: mine.reportId });

    await expect(
      reinstateAccount(
        db,
        operator.id,
        author.id,
        "appeal upheld",
        await standingSuspensionId(author.id),
        { reportId: foreign },
      ),
    ).rejects.toBeInstanceOf(ReportSubjectMismatchError);

    // And the whole thing rolls back: the report stays open AND the account
    // stays suspended. A lift that could not claim its report is not a lift.
    const row = await db.query.reports.findFirst({ where: eq(schema.reports.id, foreign) });
    expect(row?.state).toBe("open");
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, author.id),
    });
    expect(profile?.suspendedAt).not.toBeNull();
  });

  it("records one hide and one suspend, both linked to the report", async () => {
    const { commentId, reportId } = await reportedComment();
    await suspendAccount(db, operator.id, author.id, "abuse", { reportId });
    const actions = await listModerationActions(db, 10);
    expect(actions.filter((a) => a.action === "hide")).toHaveLength(1);
    expect(actions.filter((a) => a.action === "suspend")).toHaveLength(1);
    // Both carry the report id: a trail that cannot say which complaint caused
    // a takedown answers an appeal with half the story.
    const rows = await db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.subjectId, commentId));
    expect(rows).toHaveLength(1);
    expect(rows[0].reportId).toBe(reportId);
  });

  it("still takes down a second report's subject while the account is already suspended", async () => {
    const first = await reportedComment();
    await suspendAccount(db, operator.id, author.id, "abuse", { reportId: first.reportId });
    const second = await reportedComment();

    // The account is already answered for; this report is about a different
    // comment, which still has to come down.
    await suspendAccount(db, operator.id, author.id, "abuse again", { reportId: second.reportId });
    expect(await isModerationHidden(db, "comment", second.commentId)).toBe(true);
    expect(await countOpenReports(db)).toBe(0);
    // Still one suspension: the standing decision is not replaced.
    expect(
      (await listModerationActions(db, 20)).filter((a) => a.action === "suspend"),
    ).toHaveLength(1);
  });
});

/**
 * Migration 0030 backfills `reports.subject_owner_id` for rows filed before
 * 0029 added the column.
 *
 * The guarantee it protects — a report stays claimable after a hard `deletePour`
 * — held only for reports filed after that deployment, because older rows carry
 * null and fall back to deriving the owner from a subject that may be gone.
 * Testing the shipped SQL itself rather than a re-implementation of it: a
 * backfill that is right in the test and wrong in the file is the failure mode.
 */
describe("backfilling report owners filed before the column existed", () => {
  const statements = readFileSync("src/db/migrations/0030_backfill_report_subject_owner.sql", "utf8")
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((chunk) => chunk.length > 0);

  async function runBackfill() {
    for (const statement of statements) await db.execute(sql.raw(statement));
  }

  /** A report as the old code wrote them: no owner recorded. */
  async function legacyReport(subjectType: schema.ReportSubjectType, subjectId: string) {
    const id = uid("report");
    await db.insert(schema.reports).values({
      id,
      subjectType,
      subjectId,
      subjectOwnerId: null,
      reporterId: reporter.id,
      reason: "abuse",
    });
    return id;
  }

  async function ownerOf(reportId: string) {
    const row = await db.query.reports.findFirst({ where: eq(schema.reports.id, reportId) });
    return row?.subjectOwnerId ?? null;
  }

  it("derives the owner of every subject type", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db
      .insert(schema.comments)
      .values({ id: commentId, pourId, userId: author.id, body: "abuse" });

    const onPour = await legacyReport("pour", pourId);
    const onComment = await legacyReport("comment", commentId);
    const onProfile = await legacyReport("profile", author.id);

    await runBackfill();

    expect(await ownerOf(onPour)).toBe(author.id);
    expect(await ownerOf(onComment)).toBe(author.id);
    // A profile report's subject IS its owner.
    expect(await ownerOf(onProfile)).toBe(author.id);
  });

  it("leaves a recorded owner alone, and re-running changes nothing", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });

    // A row that already names an owner — even one the live subject disagrees
    // with — is the recorded fact and must not be re-derived over.
    const id = uid("report");
    await db.insert(schema.reports).values({
      id,
      subjectType: "pour",
      subjectId: pourId,
      subjectOwnerId: reporter.id,
      reporterId: reporter.id,
      reason: "abuse",
    });

    await runBackfill();
    expect(await ownerOf(id)).toBe(reporter.id);

    await runBackfill();
    expect(await ownerOf(id)).toBe(reporter.id);
  });

  it("leaves a report whose subject is already gone null rather than guessing", async () => {
    const orphan = await legacyReport("pour", uid("pour"));
    await runBackfill();
    // Unrecoverable, and it was unresolvable before the backfill too. Writing
    // any owner here would be inventing one.
    expect(await ownerOf(orphan)).toBeNull();
  });
});


/**
 * `editComment` reads the row, checks it is not deleted, then writes on the id
 * alone. A hide landing between the two replaced the body of an
 * already-hidden comment while leaving `deletedAt` untouched — and
 * `unhideSubject` restores by matching `deletedAt` against the hide's own
 * timestamp, so the match still succeeded and published text written while
 * hidden and never reviewed.
 */
describe("an edit racing a hide", () => {
  let commentPourId: string;

  async function hiddenComment(body: string) {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    commentPourId = pourId;
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body });
    return commentId;
  }

  it("cannot replace the body of a comment a moderator has hidden", async () => {
    const commentId = await hiddenComment("the reported text");
    await hideSubject(db, operator.id, "comment", commentId, { note: "abuse" });

    // The author's edit is the write half of the race: it arrives believing
    // the row was undeleted, which it was when the check ran.
    expect(await editComment(db, author.id, commentId, "something harmless")).toBeNull();

    const row = await db.query.comments.findFirst({
      where: eq(schema.comments.id, commentId),
    });
    expect(row?.body).toBe("the reported text");
    expect(row?.deletedAt).not.toBeNull();
  });

  it("restores the reported text, not a replacement, when the hide is lifted", async () => {
    const commentId = await hiddenComment("the reported text");
    await hideSubject(db, operator.id, "comment", commentId, { note: "abuse" });
    await editComment(db, author.id, commentId, "something harmless");

    await unhideSubject(
      db,
      operator.id,
      "comment",
      commentId,
      "appeal upheld",
      await standingHideId("comment", commentId),
    );

    const row = await db.query.comments.findFirst({
      where: eq(schema.comments.id, commentId),
    });
    expect(row?.deletedAt).toBeNull();
    // What comes back is what was reviewed.
    expect(row?.body).toBe("the reported text");
  });

  /**
   * The author keeps their own control while a hide stands. The hide takes the
   * comment from everyone else; it does not take away the author's decision
   * about their own words — and `softDeleteComment` leaves `deletedAt` at the
   * hide's instant, so the lift's timestamp match still holds and simply finds
   * nothing to restore.
   */
  it("lets the author withdraw their comment while a hide stands, and does not give it back", async () => {
    const commentId = await hiddenComment("the reported text");
    await hideSubject(db, operator.id, "comment", commentId, { note: "abuse" });

    expect(await softDeleteComment(db, author.id, commentId)).toBe(true);
    const withdrawn = await db.query.comments.findFirst({
      where: eq(schema.comments.id, commentId),
    });
    expect(withdrawn?.authorDeletedAt).not.toBeNull();

    await unhideSubject(
      db,
      operator.id,
      "comment",
      commentId,
      "appeal upheld",
      await standingHideId("comment", commentId),
    );
    const row = await db.query.comments.findFirst({
      where: eq(schema.comments.id, commentId),
    });
    // Upholding the appeal returns control, not the comment: its author had
    // already decided it should go.
    expect(row?.deletedAt).not.toBeNull();
  });

  it("still restores one the author left alone", async () => {
    const commentId = await hiddenComment("the reported text");
    await hideSubject(db, operator.id, "comment", commentId, { note: "abuse" });

    await unhideSubject(
      db,
      operator.id,
      "comment",
      commentId,
      "appeal upheld",
      await standingHideId("comment", commentId),
    );
    const row = await db.query.comments.findFirst({
      where: eq(schema.comments.id, commentId),
    });
    expect(row?.deletedAt).toBeNull();
    expect(row?.body).toBe("the reported text");
  });

  it("keeps the delete control in front of the author while hidden", async () => {
    const commentId = await hiddenComment("the reported text");
    await hideSubject(db, operator.id, "comment", commentId, { note: "abuse" });

    const own = await listComments(db, author.id, commentPourId);
    const row = own!.find((c) => c.id === commentId);
    // Tombstoned for everyone, still theirs to withdraw for good.
    expect(row?.canDelete).toBe(true);

    await softDeleteComment(db, author.id, commentId);
    const after = await listComments(db, author.id, commentPourId);
    expect(after!.find((c) => c.id === commentId)?.canDelete).toBe(false);
  });
});


/**
 * `unhideSubject` restores a comment by matching its `deletedAt` against the
 * hide's own `createdAt`, so it never republishes what an author deliberately
 * deleted. Two instants can share a millisecond, though — an author's delete
 * and a hide landing right behind it — and then the match succeeds on a
 * coincidence. A timestamp is not an identity; the hide records whether it was
 * the thing that took the row down.
 */
describe("a hide landing in the same millisecond as the author's own delete", () => {
  async function comment(body = "the author's text") {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body });
    return commentId;
  }

  it("does not republish it when the hide is lifted", async () => {
    const commentId = await comment();
    const sameMoment = new Date(1_000);

    // The author's own deletion, and a hide arriving at the same instant.
    await db
      .update(schema.comments)
      .set({ deletedAt: sameMoment })
      .where(eq(schema.comments.id, commentId));
    await hideSubject(db, operator.id, "comment", commentId, { note: "abuse" }, sameMoment);

    await unhideSubject(
      db,
      operator.id,
      "comment",
      commentId,
      "appeal upheld",
      await standingHideId("comment", commentId),
      new Date(2_000),
    );

    const row = await db.query.comments.findFirst({
      where: eq(schema.comments.id, commentId),
    });
    // Still the author's decision, which the lift has no business reversing.
    expect(row?.deletedAt).not.toBeNull();
  });

  it("still restores one the hide actually took down", async () => {
    const commentId = await comment();
    await hideSubject(db, operator.id, "comment", commentId, { note: "abuse" });

    await unhideSubject(
      db,
      operator.id,
      "comment",
      commentId,
      "appeal upheld",
      await standingHideId("comment", commentId),
    );

    const row = await db.query.comments.findFirst({
      where: eq(schema.comments.id, commentId),
    });
    expect(row?.deletedAt).toBeNull();
  });

  it("records which of the two it was", async () => {
    const took = await comment();
    await hideSubject(db, operator.id, "comment", took, { note: "abuse" });
    const already = await comment();
    await db
      .update(schema.comments)
      .set({ deletedAt: new Date(1_000) })
      .where(eq(schema.comments.id, already));
    await hideSubject(db, operator.id, "comment", already, { note: "abuse" });

    const rows = await db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.action, "hide"));
    expect(rows.find((r) => r.subjectId === took)?.tookDown).toBe(true);
    expect(rows.find((r) => r.subjectId === already)?.tookDown).toBe(false);
  });
});

/**
 * `liveReadable` is false both when the subject is gone and when it is merely
 * out of the operator's reach, so a report with no snapshot and nothing
 * readable could not tell those apart — and the queue said "no longer exists"
 * about a subject that was simply private.
 */
describe("telling a deleted subject from a withheld one", () => {
  it("reports a private-but-present subject as existing", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "private" });
    await report("pour", pourId);

    const [row] = await listOpenReports(db);
    expect(row.subjectExists).toBe(true);
    expect(row.liveReadable).toBe(false);
    expect(row.preview).toBeNull();
  });

  it("reports a deleted subject as gone", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    await report("pour", pourId);
    await db.delete(schema.pours).where(eq(schema.pours.id, pourId));

    const [row] = await listOpenReports(db);
    expect(row.subjectExists).toBe(false);
  });
});


/**
 * The suspension-created hide is the second caller of `applyHide`, and the
 * outcome flag was passed by only the first. Its `if (!changed) return` guard
 * had also stopped guarding, because every value of the outcome type is
 * truthy — a boolean-to-union refactor applied at one call site out of two.
 */
describe("the hide a suspension performs", () => {
  async function reportedComment(body = "the author's text") {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body });
    const reportId = await report("comment", commentId);
    // The shape `createReport` writes: the owner recorded on the row, which is
    // what lets the report still be claimed once its subject is hard-deleted.
    // The shared helper leaves it null on purpose, to exercise legacy rows.
    await db
      .update(schema.reports)
      .set({ subjectOwnerId: author.id })
      .where(eq(schema.reports.id, reportId));
    return { commentId, reportId };
  }

  it("records that it took the comment down", async () => {
    const { commentId, reportId } = await reportedComment();
    await suspendAccount(db, operator.id, author.id, "abuse", { reportId });

    const [row] = await db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.subjectId, commentId));
    expect(row.action).toBe("hide");
    expect(row.tookDown).toBe(true);
  });

  it("does not republish an author's deletion that shared its millisecond", async () => {
    const { commentId, reportId } = await reportedComment();
    const sameMoment = new Date(1_000);
    await db
      .update(schema.comments)
      .set({ deletedAt: sameMoment })
      .where(eq(schema.comments.id, commentId));

    await suspendAccount(db, operator.id, author.id, "abuse", { reportId }, sameMoment);

    const [row] = await db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.subjectId, commentId));
    expect(row.tookDown).toBe(false);

    await unhideSubject(
      db,
      operator.id,
      "comment",
      commentId,
      "appeal upheld",
      await standingHideId("comment", commentId),
      new Date(2_000),
    );
    const comment = await db.query.comments.findFirst({
      where: eq(schema.comments.id, commentId),
    });
    expect(comment?.deletedAt).not.toBeNull();
  });

  it("records nothing when the reported subject is gone entirely", async () => {
    const { commentId, reportId } = await reportedComment();
    await db.delete(schema.comments).where(eq(schema.comments.id, commentId));

    await suspendAccount(db, operator.id, author.id, "abuse", { reportId });

    // A hide over nothing is not a decision, and the trail should not carry
    // one. The suspension itself still stands.
    expect(
      await db
        .select()
        .from(schema.moderationActions)
        .where(eq(schema.moderationActions.subjectId, commentId)),
    ).toHaveLength(0);
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, author.id),
    });
    expect(profile?.suspendedAt).not.toBeNull();
  });
});


/**
 * The queue had `socialEnabled === true` written out by hand where
 * `commentWithdrawnByAuthor` belonged, so it went stale the moment that
 * predicate learned about comments written before their author had a profile.
 * A legacy comment withdrawn from every reader was still live-readable *to an
 * operator* — a snapshot-less report showed its current hidden body, and a
 * revision made inside the edit window appeared under "Now" where nobody else
 * could see it. STORYBOARD §3.17: an operator can act on a thing without being
 * able to read what was never shared.
 */
describe("a legacy comment whose author has since claimed a handle", () => {
  it("is not live-readable in the queue", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: reporter.id, bottleId: bottle.id, visibility: "public" });

    // Written when nothing required a profile, by an account that claims one
    // afterwards — `author` already has a profile from the outer fixture, so
    // the comment simply predates it.
    const commentId = uid("comment");
    await db.insert(schema.comments).values({
      id: commentId,
      pourId,
      userId: author.id,
      body: "written before the handle",
      createdAt: new Date(Date.now() - 365 * 24 * 3_600_000),
    });
    await report("comment", commentId);

    const [row] = await listOpenReports(db);
    expect(row.subjectExists).toBe(true);
    expect(row.liveReadable).toBe(false);
    // Withheld, not passed off as the reported text.
    expect(row.preview).toBeNull();
    expect(row.editedSinceReport).toBe(false);
  });

  it("is live-readable once written after the handle", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: reporter.id, bottleId: bottle.id, visibility: "public" });

    const commentId = uid("comment");
    await db.insert(schema.comments).values({
      id: commentId,
      pourId,
      userId: author.id,
      body: "written with a handle",
    });
    await report("comment", commentId);

    const [row] = await listOpenReports(db);
    expect(row.liveReadable).toBe(true);
    expect(row.preview).toBe("written with a handle");
  });
});


/**
 * Binding `docs/STORYBOARD.md` §3.17 pages both standing lists
 * oldest-cursor-first. They were newest-first, which put the decision nobody
 * has looked at in months behind however many pages of recent ones — on the
 * only screen carrying the control that lifts it. Reachable is not the same as
 * seen; it is the argument the report queue above already makes about itself.
 */
describe("standing lists run oldest first", () => {
  it("orders suspended accounts oldest first and pages forward in time", async () => {
    const suspended: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const account = await createTestUser(db);
      await profileFor(account, `susp_${i}`);
      await suspendAccount(db, operator.id, account.id, `reason ${i}`, {}, new Date(1_000 + i));
      suspended.push(account.id);
    }

    const first = await listSuspendedAccounts(db, { limit: 2 });
    expect(first.accounts.map((a) => a.userId)).toEqual([suspended[0], suspended[1]]);
    expect(first.nextCursor).not.toBeNull();

    const cut = first.nextCursor!.lastIndexOf("|");
    const next = await listSuspendedAccounts(db, {
      limit: 2,
      after: {
        at: new Date(first.nextCursor!.slice(0, cut)),
        userId: first.nextCursor!.slice(cut + 1),
      },
    });
    expect(next.accounts.map((a) => a.userId)).toEqual([suspended[2]]);
    expect(next.nextCursor).toBeNull();
  });
});


/**
 * "Resolve as hidden" and "Resolve as suspended" change no state — the hide or
 * the suspension already in force is what handles the later report — but they
 * are still decisions, and STORYBOARD §3.17 requires a reason for every action
 * without exception. Both branches resolved the report and recorded nothing,
 * so the reason, the operator and the time were discarded.
 */
describe("resolving a report against a decision already in force", () => {
  async function reportedComment(body = "abuse") {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db
      .insert(schema.pours)
      .values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body });
    const reportId = await report("comment", commentId);
    await db
      .update(schema.reports)
      .set({ subjectOwnerId: author.id })
      .where(eq(schema.reports.id, reportId));
    return { commentId, reportId };
  }

  it("records the operator's reason when the subject is already hidden", async () => {
    const first = await reportedComment();
    const second = await report("comment", first.commentId);
    await hideSubject(db, operator.id, "comment", first.commentId, {
      reportId: first.reportId,
      note: "graphic",
    });

    await hideSubject(db, operator.id, "comment", first.commentId, {
      reportId: second,
      note: "same comment, second complaint",
    });

    expect(await countOpenReports(db)).toBe(0);
    // Still exactly one hide — a second would put a rival entry in front of
    // the lift's timestamp match.
    const rows = await db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.subjectId, first.commentId));
    expect(rows.filter((r) => r.action === "hide")).toHaveLength(1);
    const resolved = rows.filter((r) => r.action === "resolve");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].note).toBe("same comment, second complaint");
    expect(resolved[0].reportId).toBe(second);
    expect(resolved[0].actorId).toBe(operator.id);
  });

  it("records it on a profile report closed against a standing suspension", async () => {
    await suspendAccount(db, operator.id, author.id, "abuse");
    const second = await report("profile", author.id);

    await suspendAccount(db, operator.id, author.id, "already answered for", {
      reportId: second,
    });

    expect(await countOpenReports(db)).toBe(0);
    const rows = await db
      .select()
      .from(schema.moderationActions)
      .where(eq(schema.moderationActions.subjectId, author.id));
    // One suspension, and the second report's closure named and reasoned.
    expect(rows.filter((r) => r.action === "suspend")).toHaveLength(1);
    const resolved = rows.filter((r) => r.action === "resolve");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].note).toBe("already answered for");
    expect(resolved[0].reportId).toBe(second);
  });

  it("leaves the standing hide and its notice untouched", async () => {
    const first = await reportedComment();
    const second = await report("comment", first.commentId);
    await hideSubject(db, operator.id, "comment", first.commentId, {
      reportId: first.reportId,
      note: "graphic",
    });
    await hideSubject(db, operator.id, "comment", first.commentId, {
      reportId: second,
      note: "second complaint",
    });

    // `resolve` is outside every hide/unhide filter: the hide still stands,
    // the standing list still lifts it, and the author's notice still reads
    // the reason they were given.
    expect(await isModerationHidden(db, "comment", first.commentId)).toBe(true);
    const notice = await moderationNoticeFor(db, "comment", first.commentId);
    expect(notice?.reason).toBe("graphic");
    const { hides } = await listStandingHides(db);
    expect(hides.map((h) => h.subjectId)).toContain(first.commentId);
  });
});


/**
 * `account.encryptOAuthTokens` only encrypts tokens written after it, so every
 * row already in the table kept its plaintext values — for accounts that may
 * never sign in again — while `/privacy` had just started saying the
 * provider's tokens are encrypted at rest. Migration 0032 clears them, which
 * is the stronger answer and the one the app can afford: nothing reads these
 * columns.
 */
describe("clearing OAuth tokens written before encryption was on", () => {
  const statements = readFileSync("src/db/migrations/0032_clear_legacy_oauth_tokens.sql", "utf8")
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((chunk) => chunk.length > 0);

  async function runMigration() {
    for (const statement of statements) await db.execute(sql.raw(statement));
  }

  it("empties every token column and leaves the account itself", async () => {
    await db.insert(schema.account).values({
      id: uid("account"),
      accountId: "google-123",
      providerId: "google",
      userId: author.id,
      accessToken: "plaintext-access",
      refreshToken: "plaintext-refresh",
      idToken: "plaintext-id",
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
      scope: "openid email",
    });

    await runMigration();

    const row = await db.query.account.findFirst({
      where: eq(schema.account.userId, author.id),
    });
    expect(row).toBeDefined();
    expect(row?.accessToken).toBeNull();
    expect(row?.refreshToken).toBeNull();
    expect(row?.idToken).toBeNull();
    expect(row?.accessTokenExpiresAt).toBeNull();
    expect(row?.refreshTokenExpiresAt).toBeNull();
    // The link to the provider is what signs the user in; only the tokens go.
    expect(row?.accountId).toBe("google-123");
    expect(row?.providerId).toBe("google");
  });

  it("runs again without complaint", async () => {
    await db.insert(schema.account).values({
      id: uid("account"),
      accountId: "apple-123",
      providerId: "apple",
      userId: author.id,
      idToken: "plaintext-id",
    });
    await runMigration();
    // A second run touches nothing and does not throw.
    await expect(runMigration()).resolves.not.toThrow();
    const row = await db.query.account.findFirst({
      where: eq(schema.account.userId, author.id),
    });
    expect(row?.idToken).toBeNull();
  });
});

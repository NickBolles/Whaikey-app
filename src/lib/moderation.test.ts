import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
  listSuspendedAccounts,
  isModerationHidden,
  moderationNoticeFor,
  unhideSubject,
  countOpenReports,
  commentNoticesForAuthor,
  ReportAlreadyHandledError,
  reinstateAccount,
  suspendAccount,
} from "./moderation";
import { AccountSuspendedError, setSocialEnabled } from "./social";

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
): Promise<string> {
  const id = uid("report");
  await db
    .insert(schema.reports)
    .values({ id, subjectType, subjectId, reporterId: reporter.id, reason: "abuse", createdAt });
  return id;
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
    await reinstateAccount(db, operator.id, author.id, "appealed successfully");

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
      reinstateAccount(db, operator.id, "no-such-user", undefined),
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

    const suspended = await listSuspendedAccounts(db);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toMatchObject({ userId: author.id, reason: "repeated abuse" });

    await reinstateAccount(db, operator.id, author.id, "appeal upheld");
    expect(await listSuspendedAccounts(db)).toHaveLength(0);
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
    await unhideSubject(db, operator.id, "pour", pourId, "appeal upheld");
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

    await unhideSubject(db, operator.id, "pour", pourId, "appeal upheld");

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

    await unhideSubject(db, operator.id, "pour", pourId, undefined);
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
    await unhideSubject(db, operator.id, "comment", commentId, "appeal upheld");

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
    await unhideSubject(db, operator.id, "comment", commentId, "appeal upheld");

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
    await unhideSubject(db, operator.id, "pour", pourId, "lifted", new Date(2_000));
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
    await unhideSubject(db, operator.id, "pour", pourId, "lifted", new Date(2_000));

    expect((await listModerationActions(db)).filter((e) => e.standing)).toHaveLength(0);
  });
});

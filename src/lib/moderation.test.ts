import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  REPORT_SLA_HOURS,
  UnknownSubjectError,
  countBreachedReports,
  dismissReport,
  hideSubject,
  listModerationActions,
  listOpenReports,
  reinstateAccount,
  resolveReport,
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
    await resolveReport(db, reportId);

    const [row] = await db.select().from(schema.comments).where(eq(schema.comments.id, commentId));
    expect(row.deletedAt).not.toBeNull();
    // The words are still there: hiding is not deletion, and an appeal needs
    // something to appeal about.
    expect(row.body).toBe("no");
    expect(await listOpenReports(db)).toHaveLength(0);
  });

  it("makes a reported pour private rather than deleting somebody's journal", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: author.id, bottleId: bottle.id, visibility: "public" });

    await hideSubject(db, operator.id, "pour", pourId, {});
    const [row] = await db.select().from(schema.pours).where(eq(schema.pours.id, pourId));
    expect(row.visibility).toBe("private");
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
    await resolveReport(db, reportId);

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

  it("will not dismiss the same report twice", async () => {
    const reportId = await report("profile", author.id);
    await dismissReport(db, operator.id, reportId, undefined);
    await expect(dismissReport(db, operator.id, reportId, undefined)).rejects.toBeInstanceOf(
      UnknownSubjectError,
    );
  });
});

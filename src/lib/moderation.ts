import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db";
import {
  comments,
  moderationActions,
  pours,
  reports,
  user,
  userProfiles,
  type ModerationActionKind,
  type ReportSubjectType,
} from "@/db/schema";

/**
 * The moderation queue (PLAN.md §9.4, review PLAN-C9).
 *
 * `/api/social/reports` has existed for a while and **nothing read it**. The
 * app ships profiles, feeds and comments, so a store submission needs a queue
 * an operator can actually work — and the review's finding is not that reports
 * were missing, it is that writing them was mistaken for handling them.
 *
 * Every action here does two things: it changes the thing, and it writes an
 * append-only record of who changed it and why. Without the second, the queue
 * reopens the same hole one level up — decisions made and nowhere to answer an
 * appeal from.
 */

/** How long a report may sit before the queue calls it late (PLAN.md §9.4). */
export const REPORT_SLA_HOURS = 72;

export interface QueuedReport {
  id: string;
  subjectType: ReportSubjectType;
  subjectId: string;
  reason: string;
  createdAt: Date;
  reporterHandle: string | null;
  /** Hours since it arrived; over `REPORT_SLA_HOURS` is a breach. */
  ageHours: number;
  /** Enough of the subject to judge it without leaving the queue. */
  preview: string | null;
  /** The account that owns the reported thing, when there is one. */
  subjectOwnerId: string | null;
  subjectOwnerSuspended: boolean;
  /** Already hidden by an earlier action — the queue says so rather than repeating it. */
  alreadyHidden: boolean;
}

/**
 * Open reports, oldest first.
 *
 * Oldest first on purpose: a queue sorted newest-first is a queue where the
 * thing that has been waiting longest is the thing you never see, which is how
 * an SLA becomes decorative.
 */
export async function listOpenReports(db: DB, now = new Date()): Promise<QueuedReport[]> {
  const rows = await db
    .select({
      id: reports.id,
      subjectType: reports.subjectType,
      subjectId: reports.subjectId,
      reason: reports.reason,
      createdAt: reports.createdAt,
      reporterHandle: userProfiles.handle,
    })
    .from(reports)
    .leftJoin(userProfiles, eq(userProfiles.userId, reports.reporterId))
    .where(eq(reports.state, "open"))
    .orderBy(reports.createdAt);

  return Promise.all(
    rows.map(async (row) => {
      const subject = await describeSubject(db, row.subjectType, row.subjectId);
      return {
        ...row,
        ageHours: Math.floor((now.getTime() - row.createdAt.getTime()) / 3_600_000),
        ...subject,
      };
    }),
  );
}

interface SubjectDescription {
  preview: string | null;
  subjectOwnerId: string | null;
  subjectOwnerSuspended: boolean;
  alreadyHidden: boolean;
}

/** Enough of the reported thing to judge it, and nothing more. */
async function describeSubject(
  db: DB,
  subjectType: ReportSubjectType,
  subjectId: string,
): Promise<SubjectDescription> {
  const empty: SubjectDescription = {
    preview: null,
    subjectOwnerId: null,
    subjectOwnerSuspended: false,
    alreadyHidden: false,
  };

  if (subjectType === "comment") {
    const row = await db.query.comments.findFirst({
      columns: { body: true, userId: true, deletedAt: true },
      where: eq(comments.id, subjectId),
    });
    if (!row) return empty;
    return {
      preview: row.body.slice(0, 500),
      subjectOwnerId: row.userId,
      subjectOwnerSuspended: await isSuspended(db, row.userId),
      alreadyHidden: row.deletedAt != null,
    };
  }

  if (subjectType === "pour") {
    const row = await db.query.pours.findFirst({
      columns: { userId: true, visibility: true },
      where: eq(pours.id, subjectId),
    });
    if (!row) return empty;
    const note = await db.query.tastingNotes.findFirst({
      columns: { nose: true, palate: true, finish: true, freeform: true },
      where: (t, { eq: is }) => is(t.pourId, subjectId),
    });
    const text = [note?.nose, note?.palate, note?.finish, note?.freeform]
      .filter(Boolean)
      .join(" · ");
    return {
      preview: text ? text.slice(0, 500) : "(no written note)",
      subjectOwnerId: row.userId,
      subjectOwnerSuspended: await isSuspended(db, row.userId),
      // "Hidden" for a pour means private: it leaves every social projection
      // without deleting anything of its owner's.
      alreadyHidden: row.visibility === "private",
    };
  }

  const row = await db.query.userProfiles.findFirst({
    columns: { handle: true, displayName: true, bio: true, socialEnabled: true, suspendedAt: true },
    where: eq(userProfiles.userId, subjectId),
  });
  if (!row) return empty;
  return {
    preview: [`@${row.handle}`, row.displayName, row.bio].filter(Boolean).join(" · ").slice(0, 500),
    subjectOwnerId: subjectId,
    subjectOwnerSuspended: row.suspendedAt != null,
    // For a profile there is no hide, so "handled" means suspended. Reading
    // `socialEnabled` here would call every account that has stepped back of
    // its own accord already-actioned, which is somebody's privacy choice
    // wearing a moderation label.
    alreadyHidden: row.suspendedAt != null,
  };
}

async function isSuspended(db: DB, userId: string): Promise<boolean> {
  const row = await db.query.userProfiles.findFirst({
    columns: { suspendedAt: true },
    where: eq(userProfiles.userId, userId),
  });
  return row?.suspendedAt != null;
}

export class UnknownSubjectError extends Error {
  constructor() {
    super("There is nothing at that id to act on");
    this.name = "UnknownSubjectError";
  }
}

export class CannotHideProfileError extends Error {
  constructor() {
    super("A profile is suspended, not hidden");
    this.name = "CannotHideProfileError";
  }
}

/**
 * Take a piece of content out of the social surfaces.
 *
 * Each subject type already has the right mechanism, so this uses it rather
 * than inventing a parallel "hidden" flag that every read path would have to
 * learn: a comment soft-deletes (it already renders as removed) and a pour
 * goes private (it leaves every projection and stays in its owner's journal).
 * Nobody's own records are destroyed by a moderation action — that is
 * deletion, and it is not this.
 *
 * **A profile is not hideable, and the honest reason is that it cannot be.**
 * The only lever a profile has is `socialEnabled`, which is a switch in the
 * account's own settings — so "hiding" one would last exactly as long as it
 * took its owner to find the toggle they already have, while telling the
 * operator they had acted. A profile is suspended or it is not; suspension is
 * the action that sticks, and it is the one this queue offers.
 */
export async function hideSubject(
  db: DB,
  actorId: string,
  subjectType: ReportSubjectType,
  subjectId: string,
  options: { reportId?: string; note?: string } = {},
  now = new Date(),
): Promise<void> {
  if (subjectType === "profile") throw new CannotHideProfileError();
  const changed = await applyHide(db, subjectType, subjectId, now);
  if (!changed) throw new UnknownSubjectError();
  await record(db, actorId, "hide", subjectType, subjectId, options, now);
}

async function applyHide(
  db: DB,
  subjectType: ReportSubjectType,
  subjectId: string,
  now: Date,
): Promise<boolean> {
  if (subjectType === "comment") {
    const rows = await db
      .update(comments)
      .set({ deletedAt: now })
      .where(and(eq(comments.id, subjectId), isNull(comments.deletedAt)))
      .returning({ id: comments.id });
    // Already hidden is a success, not a failure: two operators working the
    // same report must not produce an error for the second one.
    return rows.length > 0 || (await exists(db, "comment", subjectId));
  }
  const rows = await db
    .update(pours)
    .set({ visibility: "private" })
    .where(eq(pours.id, subjectId))
    .returning({ id: pours.id });
  return rows.length > 0;
}

/** Only the hideable subjects reach this; a profile is suspended, not hidden. */
async function exists(db: DB, subjectType: "comment" | "pour", subjectId: string): Promise<boolean> {
  if (subjectType === "comment") {
    return (
      (await db.query.comments.findFirst({ columns: { id: true }, where: eq(comments.id, subjectId) })) != null
    );
  }
  return (await db.query.pours.findFirst({ columns: { id: true }, where: eq(pours.id, subjectId) })) != null;
}

/**
 * Suspend an account from the social surfaces.
 *
 * Not a deletion and not a ban from the product: the journal, the shelf and
 * the export are untouched, because someone's own records are not the thing
 * being moderated. `socialEnabled` goes off with it, and `setSocialEnabled`
 * refuses to turn it back on while the suspension stands — otherwise the
 * suspension lasts as long as it takes to find the toggle the account already
 * has.
 */
export async function suspendAccount(
  db: DB,
  actorId: string,
  userId: string,
  reason: string,
  options: { reportId?: string } = {},
  now = new Date(),
): Promise<void> {
  if (actorId === userId) {
    // Not a safety rail so much as a correctness one: an operator suspending
    // themselves locks the queue with nobody able to reopen it.
    throw new UnknownSubjectError();
  }
  const rows = await db
    .update(userProfiles)
    .set({
      suspendedAt: now,
      suspendedReason: reason.trim() || null,
      socialEnabled: false,
      isPublic: false,
      discoverable: false,
      updatedAt: now,
    })
    .where(eq(userProfiles.userId, userId))
    .returning({ userId: userProfiles.userId });
  if (rows.length === 0) throw new UnknownSubjectError();
  await record(db, actorId, "suspend", "profile", userId, { ...options, note: reason }, now);
}

/**
 * Lift a suspension.
 *
 * `socialEnabled` deliberately stays off: the system never raises a
 * visibility, so the account turns its own surfaces back on when it chooses.
 */
export async function reinstateAccount(
  db: DB,
  actorId: string,
  userId: string,
  note: string | undefined,
  now = new Date(),
): Promise<void> {
  const rows = await db
    .update(userProfiles)
    .set({ suspendedAt: null, suspendedReason: null, updatedAt: now })
    .where(eq(userProfiles.userId, userId))
    .returning({ userId: userProfiles.userId });
  if (rows.length === 0) throw new UnknownSubjectError();
  await record(db, actorId, "reinstate", "profile", userId, { note }, now);
}

/** Close a report without acting on it — with a reason, always. */
export async function dismissReport(
  db: DB,
  actorId: string,
  reportId: string,
  note: string | undefined,
  now = new Date(),
): Promise<void> {
  const [row] = await db
    .update(reports)
    .set({ state: "dismissed" })
    .where(and(eq(reports.id, reportId), eq(reports.state, "open")))
    .returning({ subjectType: reports.subjectType, subjectId: reports.subjectId });
  if (!row) throw new UnknownSubjectError();
  await record(db, actorId, "dismiss", row.subjectType, row.subjectId, { reportId, note }, now);
}

/** Mark a report handled. Called after an action that changed something. */
export async function resolveReport(db: DB, reportId: string): Promise<void> {
  await db
    .update(reports)
    .set({ state: "resolved" })
    .where(and(eq(reports.id, reportId), eq(reports.state, "open")));
}

async function record(
  db: DB,
  actorId: string,
  action: ModerationActionKind,
  subjectType: ReportSubjectType,
  subjectId: string,
  options: { reportId?: string; note?: string },
  now: Date,
): Promise<void> {
  await db.insert(moderationActions).values({
    id: crypto.randomUUID(),
    actorId,
    action,
    subjectType,
    subjectId,
    reportId: options.reportId ?? null,
    note: options.note?.trim() || null,
    createdAt: now,
  });
}

export interface AuditEntry {
  id: string;
  action: ModerationActionKind;
  subjectType: ReportSubjectType;
  subjectId: string;
  note: string | null;
  createdAt: Date;
  actorName: string;
}

/** The audit trail, newest first — what an appeal is answered from. */
export async function listModerationActions(db: DB, limit = 100): Promise<AuditEntry[]> {
  return db
    .select({
      id: moderationActions.id,
      action: moderationActions.action,
      subjectType: moderationActions.subjectType,
      subjectId: moderationActions.subjectId,
      note: moderationActions.note,
      createdAt: moderationActions.createdAt,
      actorName: user.name,
    })
    .from(moderationActions)
    .innerJoin(user, eq(user.id, moderationActions.actorId))
    .orderBy(desc(moderationActions.createdAt))
    .limit(limit);
}

/** How many open reports are past the SLA, for the queue's own header. */
export async function countBreachedReports(db: DB, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - REPORT_SLA_HOURS * 3_600_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(reports)
    .where(and(eq(reports.state, "open"), sql`${reports.createdAt} < ${cutoff}`));
  return Number(row?.n ?? 0);
}

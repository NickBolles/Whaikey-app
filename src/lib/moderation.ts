import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db";
import {
  comments,
  moderationActions,
  pourShares,
  pours,
  reports,
  user,
  userProfiles,
  userSocialPrefs,
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
  /** Which suspension, so this row's Reinstate cannot lift a newer one. */
  subjectOwnerSuspendedAt: Date | null;
  /** Already hidden by an earlier action — the queue says so rather than repeating it. */
  alreadyHidden: boolean;
}

/**
 * How many reports one page of the queue holds.
 *
 * Bounded because the thing this queue is for is abuse, and abuse arrives in
 * volume: the per-reporter limiter says nothing about the size of the global
 * backlog, and each row costs one or two more queries to describe. An
 * unbounded read makes the page fall over exactly when it is needed. Oldest
 * first, so a page is always the work most overdue.
 */
export const REPORT_PAGE_SIZE = 100;

/**
 * Open reports, oldest first.
 *
 * Oldest first on purpose: a queue sorted newest-first is a queue where the
 * thing that has been waiting longest is the thing you never see, which is how
 * an SLA becomes decorative.
 */
export async function listOpenReports(
  db: DB,
  now = new Date(),
  limit = REPORT_PAGE_SIZE,
): Promise<QueuedReport[]> {
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
    .orderBy(reports.createdAt)
    .limit(limit);

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
  subjectOwnerSuspendedAt: Date | null;
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
    subjectOwnerSuspendedAt: null,
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
      ...(await suspensionOf(db, row.userId)),
      alreadyHidden: await isModerationHidden(db, "comment", subjectId),
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
      ...(await suspensionOf(db, row.userId)),
      /**
       * "Already handled" means a moderation hide stands — never that the
       * content happens to be out of sight.
       *
       * Reading `visibility === "private"` let an owner disable the Hide
       * button by making the reported pour private themselves: no moderation
       * action was ever recorded, so nothing stopped them republishing it
       * afterwards. Temporarily hiding your own content would have been a way
       * round the one mechanism that sticks. Same reading as the profile row,
       * where the flag means suspended rather than socially switched off.
       */
      alreadyHidden: await isModerationHidden(db, "pour", subjectId),
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
    subjectOwnerSuspendedAt: row.suspendedAt,
    // For a profile there is no hide, so "handled" means suspended. Reading
    // `socialEnabled` here would call every account that has stepped back of
    // its own accord already-actioned, which is somebody's privacy choice
    // wearing a moderation label.
    alreadyHidden: row.suspendedAt != null,
  };
}

/** Whether an account is suspended, and by which decision. */
async function suspensionOf(
  db: DB,
  userId: string,
): Promise<{ subjectOwnerSuspended: boolean; subjectOwnerSuspendedAt: Date | null }> {
  const row = await db.query.userProfiles.findFirst({
    columns: { suspendedAt: true },
    where: eq(userProfiles.userId, userId),
  });
  return {
    subjectOwnerSuspended: row?.suspendedAt != null,
    subjectOwnerSuspendedAt: row?.suspendedAt ?? null,
  };
}

export class UnknownSubjectError extends Error {
  constructor() {
    super("There is nothing at that id to act on");
    this.name = "UnknownSubjectError";
  }
}

/**
 * Raised when an operator acts on a decision that is no longer the current one.
 *
 * Every queue screen is a snapshot, and a second operator can move the world
 * between the render and the click. Silently applying the stale action would
 * overturn a decision nobody reviewed, so the write refuses and the page
 * reloads to show what is actually in force.
 */
export class StaleModerationViewError extends Error {
  constructor() {
    super("That decision has changed since this page was loaded");
    this.name = "StaleModerationViewError";
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
  // One transaction: content hidden with no audit row is a decision nobody can
  // answer an appeal from, and an audit row with nothing hidden is worse.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${moderationLockKey(subjectType, subjectId)}))`,
    );

    /**
     * A hide over a hide records nothing.
     *
     * Two open reports on one comment, or two stale tabs, would otherwise
     * append a second `hide` with a newer timestamp while `deletedAt` still
     * holds the first one's. Lifting then compares the two, matches nothing,
     * restores nothing — and clears the notice anyway, leaving an anonymous
     * tombstone its author cannot see a reason for or get back. The first
     * hide's timestamp is the one that means something, so it is the one kept.
     *
     * The second operator's report is still resolved: their report genuinely
     * is handled, by the action already in force.
     */
    if (await isModerationHidden(tx, subjectType, subjectId)) {
      if (!(await exists(tx, subjectType, subjectId))) throw new UnknownSubjectError();
      if (options.reportId) {
        await resolveOpenReport(tx, options.reportId, { subjectType, subjectId });
      }
      return;
    }

    const changed = await applyHide(tx, subjectType, subjectId, now);
    if (!changed) throw new UnknownSubjectError();
    await record(tx, actorId, "hide", subjectType, subjectId, options, now);
    if (options.reportId) {
      await resolveOpenReport(tx, options.reportId, { subjectType, subjectId });
    }
  });
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
  if (rows.length === 0) return false;

  /**
   * A `/s/<code>` link is a separate door and `getPublicPourShare` opens it on
   * `revokedAt` alone — it never looks at the pour's visibility. Making the
   * pour private without this leaves the exact content the operator hid still
   * readable by anyone holding the URL, which is the failure mode the whole
   * action exists to prevent. `makeEverythingPrivate` revokes for the same
   * reason; a moderation hide has to do at least as much.
   */
  await db
    .update(pourShares)
    .set({ revokedAt: now })
    .where(and(eq(pourShares.pourId, subjectId), isNull(pourShares.revokedAt)));
  return true;
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
  await db.transaction(async (tx) => {
    /**
     * The same lock `makeEverythingPrivate` and `createPourShare` contend on.
     * Without it a share request already in flight can mint a live bearer link
     * immediately after the suspension commits — the account is off every
     * social surface and still handing out URLs.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`social-reset:${userId}`}))`);

    const rows = await tx
      .update(userProfiles)
      .set({
        suspendedAt: now,
        suspendedReason: reason.trim() || null,
        socialEnabled: false,
        isPublic: false,
        discoverable: false,
        // Cleared for the same reason `makeEverythingPrivate` clears it: the
        // account's own "turn social back on" would otherwise make the stored
        // number findable again after reinstatement, with no fresh opt-in.
        // Every other flag here is one they can set again deliberately; this
        // one they would never be asked about.
        phoneDiscoverable: false,
        updatedAt: now,
      })
      .where(eq(userProfiles.userId, userId))
      .returning({ userId: userProfiles.userId });
    if (rows.length === 0) throw new UnknownSubjectError();

    /**
     * Turning the profile flags off is not enough, because a `/s/<code>` link
     * does not consult them: `getPublicPourShare` authorises on `revokedAt`
     * alone. A suspended account with live links is suspended from the parts
     * of the product nobody was reading and not from the one URL somebody
     * already has. So the suspension applies the same account-wide reset the
     * owner's own step-back does — pours private, links revoked, default
     * visibility private.
     *
     * None of it is restored by reinstating. That is deliberate and it is the
     * same rule everywhere here: the system never raises a visibility, so
     * coming back means choosing again.
     */
    await tx.update(pours).set({ visibility: "private" }).where(eq(pours.userId, userId));
    await tx
      .update(pourShares)
      .set({ revokedAt: now })
      .where(and(eq(pourShares.userId, userId), isNull(pourShares.revokedAt)));
    await tx
      .insert(userSocialPrefs)
      .values({ userId, defaultPourVisibility: "private" })
      .onConflictDoUpdate({
        target: userSocialPrefs.userId,
        set: { defaultPourVisibility: "private", updatedAt: now },
      });

    await record(tx, actorId, "suspend", "profile", userId, { ...options, note: reason }, now);
    // A suspension's report has to be about something this account owns —
    // their profile, or a pour or comment of theirs.
    if (options.reportId) await resolveOpenReport(tx, options.reportId, { ownerId: userId });
  });
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
  /**
   * The suspension the operator was looking at, as an ISO timestamp.
   * **Required**, for the same reason `unhideSubject`'s action id is: a guard
   * that can be left out is one a stale client leaves out.
   */
  expectedSuspendedAt: string,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${moderationLockKey("profile", userId)}))`,
    );
    const rows = await tx
      .update(userProfiles)
      .set({ suspendedAt: null, suspendedReason: null, updatedAt: now })
      .where(
        and(
          eq(userProfiles.userId, userId),
          eq(userProfiles.suspendedAt, new Date(expectedSuspendedAt)),
        ),
      )
      .returning({ userId: userProfiles.userId });
    if (rows.length === 0) {
      // Either the account was never suspended, or it is suspended by a
      // decision this page never showed. Both are "not yours to lift".
      const exists = await tx.query.userProfiles.findFirst({
        columns: { suspendedAt: true },
        where: eq(userProfiles.userId, userId),
      });
      if (!exists) throw new UnknownSubjectError();
      throw new StaleModerationViewError();
    }
    await record(tx, actorId, "reinstate", "profile", userId, { note }, now);
  });
}

/** Close a report without acting on it — with a reason, always. */
export async function dismissReport(
  db: DB,
  actorId: string,
  reportId: string,
  note: string | undefined,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(reports)
      .set({ state: "dismissed" })
      .where(and(eq(reports.id, reportId), eq(reports.state, "open")))
      .returning({ subjectType: reports.subjectType, subjectId: reports.subjectId });
    if (!row) throw new UnknownSubjectError();
    await record(tx, actorId, "dismiss", row.subjectType, row.subjectId, { reportId, note }, now);
  });
}

/**
 * Mark a report handled, in the same transaction as the action that handled it.
 *
 * Split from the action it belongs to, this was the third write in a
 * two-write story: the content could be hidden and the report left open, so a
 * retry recorded the action twice, and two operators on the same report both
 * acted. Predicated on `state = 'open'` so the transition happens once.
 */
async function resolveOpenReport(
  tx: DB,
  reportId: string,
  /**
   * What the action is about.
   *
   * Claiming a report by id alone let a malformed request hide subject B while
   * closing a report about subject A — and file an audit row tying B's
   * takedown to A's report, which is the trail lying about why something
   * happened. A report is a claim on *this* decision or it is not a claim.
   */
  about: { subjectType: ReportSubjectType; subjectId: string } | { ownerId: string },
): Promise<void> {
  const report = await tx.query.reports.findFirst({
    columns: { subjectType: true, subjectId: true },
    where: and(eq(reports.id, reportId), eq(reports.state, "open")),
  });
  if (!report) throw new ReportAlreadyHandledError();

  const matches =
    "subjectId" in about
      ? report.subjectType === about.subjectType && report.subjectId === about.subjectId
      : (await reportSubjectOwner(tx, report.subjectType, report.subjectId)) === about.ownerId;
  if (!matches) throw new ReportSubjectMismatchError();

  const rows = await tx
    .update(reports)
    .set({ state: "resolved" })
    .where(and(eq(reports.id, reportId), eq(reports.state, "open")))
    .returning({ id: reports.id });
  /**
   * The report is the claim, so a miss rolls the whole action back.
   *
   * Ignoring the count meant two stale tabs could dismiss and suspend the same
   * report: the loser updated nothing, committed its suspension anyway, and
   * left a report displayed as dismissed with a suspension and two conflicting
   * audit rows behind it. Losing the race has to mean losing the action.
   */
  if (rows.length === 0) throw new ReportAlreadyHandledError();
}

/** Who a reported thing belongs to, for matching a suspension to its report. */
async function reportSubjectOwner(
  tx: DB,
  subjectType: ReportSubjectType,
  subjectId: string,
): Promise<string | null> {
  if (subjectType === "profile") return subjectId;
  if (subjectType === "pour") {
    const row = await tx.query.pours.findFirst({
      columns: { userId: true },
      where: eq(pours.id, subjectId),
    });
    return row?.userId ?? null;
  }
  const row = await tx.query.comments.findFirst({
    columns: { userId: true },
    where: eq(comments.id, subjectId),
  });
  return row?.userId ?? null;
}

/** Raised when a report is offered as the claim for an action it isn't about. */
export class ReportSubjectMismatchError extends Error {
  constructor() {
    super("That report is not about the thing being acted on");
    this.name = "ReportSubjectMismatchError";
  }
}

export class ReportAlreadyHandledError extends Error {
  constructor() {
    super("Somebody else already handled that report");
    this.name = "ReportAlreadyHandledError";
  }
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
  /**
   * True only for the hide that is currently in force over its subject.
   *
   * The trail is history, so it holds hides that were lifted and hides that a
   * later hide superseded. Offering "lift" on all of them would let a click on
   * a months-old row take down today's decision, since `unhideSubject` acts on
   * the subject rather than on the entry.
   */
  standing: boolean;
}

/** The audit trail, newest first — what an appeal is answered from. */
export async function listModerationActions(db: DB, limit = 100): Promise<AuditEntry[]> {
  const rows = await db
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
    .orderBy(desc(moderationActions.seq))
    .limit(limit);

  // Newest first, so the first hide/unhide seen for a subject is the current
  // one — and it is standing only if it is a hide.
  const decided = new Set<string>();
  return rows.map((row) => {
    const key = `${row.subjectType}:${row.subjectId}`;
    let standing = false;
    if (row.action === "hide" || row.action === "unhide") {
      if (!decided.has(key)) {
        decided.add(key);
        standing = row.action === "hide";
      }
    }
    return { ...row, standing };
  });
}

export interface OwnModerationNotice extends ModerationNotice {
  subjectType: "pour" | "comment";
  subjectId: string;
  /** Enough of the thing to recognise which one it was. */
  preview: string | null;
}

/**
 * Everything moderation currently holds down that belongs to this user.
 *
 * On a surface the account always owns, because the per-object notices are
 * not: a hidden comment's notice lives on the pour it was left under, and that
 * pour can go private, its author can switch social off, or either party can
 * block — after which the only place the reason existed is unreachable by the
 * person it is addressed to. A moderation decision they cannot read is one
 * they cannot appeal, and the Terms promise otherwise.
 */
export async function listOwnModerationHolds(
  db: DB,
  userId: string,
): Promise<OwnModerationNotice[]> {
  /**
   * Two queries, driven from the actions rather than from the content.
   *
   * The obvious shape — walk the user's pours and ask about each — is one
   * query per pour on every `/sharing` load, for an account that in the
   * overwhelming majority of cases has no holds at all. Starting from
   * `moderation_actions` and joining to the user's rows bounds the work by
   * how much moderation has touched them, which is the number that is small.
   */
  const [pourActions, commentActions] = await Promise.all([
    db
      .select({
        id: moderationActions.id,
        subjectId: moderationActions.subjectId,
        action: moderationActions.action,
        note: moderationActions.note,
        createdAt: moderationActions.createdAt,
      })
      .from(moderationActions)
      .innerJoin(
        pours,
        and(eq(pours.id, moderationActions.subjectId), eq(pours.userId, userId)),
      )
      .where(
        and(
          eq(moderationActions.subjectType, "pour"),
          sql`${moderationActions.action} in ('hide', 'unhide')`,
        ),
      )
      .orderBy(desc(moderationActions.seq)),
    db
      .select({
        id: moderationActions.id,
        subjectId: moderationActions.subjectId,
        action: moderationActions.action,
        note: moderationActions.note,
        createdAt: moderationActions.createdAt,
        body: comments.body,
      })
      .from(moderationActions)
      .innerJoin(
        comments,
        and(eq(comments.id, moderationActions.subjectId), eq(comments.userId, userId)),
      )
      .where(
        and(
          eq(moderationActions.subjectType, "comment"),
          sql`${moderationActions.action} in ('hide', 'unhide')`,
        ),
      )
      .orderBy(desc(moderationActions.seq)),
  ]);

  // Newest first, so the first row seen for a subject is the one in force.
  const held: OwnModerationNotice[] = [];
  const seen = new Set<string>();
  for (const row of pourActions) {
    if (seen.has(row.subjectId)) continue;
    seen.add(row.subjectId);
    if (row.action !== "hide") continue;
    held.push({
      action: "hide",
      reason: row.note,
      at: row.createdAt,
      subjectType: "pour",
      subjectId: row.subjectId,
      preview: null,
    });
  }
  seen.clear();
  for (const row of commentActions) {
    if (seen.has(row.subjectId)) continue;
    seen.add(row.subjectId);
    if (row.action !== "hide") continue;
    held.push({
      action: "hide",
      reason: row.note,
      at: row.createdAt,
      subjectType: "comment",
      subjectId: row.subjectId,
      preview: row.body.slice(0, 140),
    });
  }
  return held.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * How many standing hides one page shows.
 *
 * Paged rather than capped: a cap is the audit-window bug again one level out —
 * past it the oldest takedowns lose the only control that lifts them, and an
 * appeal about one has no answer in the product.
 */
export const STANDING_HIDE_PAGE_SIZE = 100;

export interface StandingHide {
  actionId: string;
  subjectType: "pour" | "comment";
  subjectId: string;
  note: string | null;
  at: Date;
  actorName: string;
}

/**
 * Every hide currently in force, newest first.
 *
 * Its own query rather than a filter over the recent-actions list: that list
 * is bounded history, so once fifty newer actions exist a hide that still
 * stands drops off it — and the only control that lifts one went with it. An
 * appeal about something hidden two months ago would have had no answer
 * available in the product.
 *
 * `distinct on` picks the latest hide/unhide per subject inside the database,
 * so the bound is on standing hides rather than on how much history has to be
 * read to find them.
 */
export async function listStandingHides(
  db: DB,
  /**
   * `before` is the previous page's last `seq`.
   *
   * The sequence is unique and monotonic, so it is both a total order and a
   * cursor with no ties to fall through — a timestamp cursor dropped every row
   * sharing the boundary instant, and those rows are neither on the page that
   * ended nor on the one that follows.
   */
  options: { limit?: number; before?: number } = {},
): Promise<{ hides: StandingHide[]; nextCursor: string | null }> {
  const limit = options.limit ?? STANDING_HIDE_PAGE_SIZE;
  // `distinct on` picks the latest hide/unhide per subject inside the
  // database, so the work is bounded by how many subjects moderation has
  // touched rather than by how much history has to be read to find them.
  const latest = db
    .selectDistinctOn([moderationActions.subjectType, moderationActions.subjectId], {
      id: moderationActions.id,
      subjectType: moderationActions.subjectType,
      subjectId: moderationActions.subjectId,
      action: moderationActions.action,
      note: moderationActions.note,
      createdAt: moderationActions.createdAt,
      seq: moderationActions.seq,
      actorId: moderationActions.actorId,
    })
    .from(moderationActions)
    .where(sql`${moderationActions.action} in ('hide', 'unhide')`)
    .orderBy(
      moderationActions.subjectType,
      moderationActions.subjectId,
      desc(moderationActions.seq),
    )
    .as("latest");

  const rows = await db
    .select({
      actionId: latest.id,
      subjectType: latest.subjectType,
      subjectId: latest.subjectId,
      note: latest.note,
      at: latest.createdAt,
      seq: latest.seq,
      actorName: user.name,
    })
    .from(latest)
    .innerJoin(user, eq(user.id, latest.actorId))
    .where(
      options.before !== undefined
        ? and(eq(latest.action, "hide"), sql`${latest.seq} < ${options.before}`)
        : eq(latest.action, "hide"),
    )
    .orderBy(desc(latest.seq))
    // One extra row is how the page knows there is another one.
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    hides: page.map((row) => ({
      actionId: row.actionId,
      subjectType: row.subjectType as "pour" | "comment",
      subjectId: row.subjectId,
      note: row.note,
      at: row.at,
      actorName: row.actorName,
    })),
    nextCursor: rows.length > limit && last ? String(last.seq) : null,
  };
}

/**
 * The moderation notices over this user's own comments on one pour.
 *
 * A hidden comment renders as an anonymous tombstone — `listComments` strips
 * the body and the author from a deleted row — so without this its author is
 * told nothing at all, which is worse than the pour case: they cannot even see
 * which of their comments went. Keyed to the signed-in author, so nobody reads
 * anybody else's.
 */
export async function commentNoticesForAuthor(
  db: DB,
  pourId: string,
  authorId: string,
): Promise<ModerationNotice[]> {
  const hidden = await db
    .select({ id: comments.id })
    .from(comments)
    .where(
      and(
        eq(comments.pourId, pourId),
        eq(comments.userId, authorId),
        isNotNull(comments.deletedAt),
      ),
    );
  const notices = await Promise.all(
    hidden.map((row) => moderationNoticeFor(db, "comment", row.id)),
  );
  return notices.filter((notice): notice is ModerationNotice => notice != null);
}

/**
 * How many suspended accounts one page shows.
 *
 * Paged for the same reason the standing hides are: this list carries the only
 * reinstate control in the product, so anything that falls off it is an
 * account nobody can bring back.
 */
export const SUSPENDED_PAGE_SIZE = 100;

export interface SuspendedAccount {
  userId: string;
  handle: string | null;
  displayName: string | null;
  reason: string | null;
  suspendedAt: Date;
}

/**
 * Who is currently suspended.
 *
 * Not a nicety: suspending resolves the report, and a resolved report leaves
 * the queue — so the Reinstate button next to it goes with it, and an appeal
 * arriving later through `/support` would find no control anywhere. A
 * suspension you cannot lift is a ban, and the Terms promise otherwise.
 */
export async function listSuspendedAccounts(
  db: DB,
  options: { limit?: number; before?: { at: Date; userId: string } } = {},
): Promise<{ accounts: SuspendedAccount[]; nextCursor: string | null }> {
  const limit = options.limit ?? SUSPENDED_PAGE_SIZE;
  const rows = await db
    .select({
      userId: userProfiles.userId,
      handle: userProfiles.handle,
      displayName: userProfiles.displayName,
      reason: userProfiles.suspendedReason,
      suspendedAt: userProfiles.suspendedAt,
    })
    .from(userProfiles)
    .where(
      options.before
        ? and(
            isNotNull(userProfiles.suspendedAt),
            sql`(${userProfiles.suspendedAt}, ${userProfiles.userId}) < (${options.before.at}, ${options.before.userId})`,
          )
        : isNotNull(userProfiles.suspendedAt),
    )
    .orderBy(desc(userProfiles.suspendedAt), desc(userProfiles.userId))
    .limit(limit + 1);

  const page = rows.slice(0, limit).map((row) => ({ ...row, suspendedAt: row.suspendedAt as Date }));
  const last = page[page.length - 1];
  return {
    accounts: page,
    nextCursor:
      rows.length > limit && last ? `${last.suspendedAt.toISOString()}|${last.userId}` : null,
  };
}

/** Every open report, counted in SQL — the page shows at most one page of them. */
export async function countOpenReports(db: DB): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(reports)
    .where(eq(reports.state, "open"));
  return Number(row?.n ?? 0);
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

/**
 * Whether a moderation hide currently stands over this subject.
 *
 * The audit trail is the record, so it is also the authority — no second
 * "moderated" column to drift out of step with it. The latest hide/unhide for
 * the subject wins, which is why `unhide` exists at all: without a reversal a
 * hide would be permanent, and an upheld appeal would have nothing to act on.
 *
 * `moderation_actions_subject_idx` covers this lookup.
 */
/**
 * The lock a moderation hold is read and written under.
 *
 * Keyed on the subject rather than its owner, because the check needs to
 * serialize with the hide and the hide does not know the owner. Without it the
 * owner's visibility PATCH can read "no hide", block on the row, and commit
 * after the hide finishes — putting back exactly what was taken down.
 */
export function moderationLockKey(subjectType: ReportSubjectType, subjectId: string): string {
  return `moderation:${subjectType}:${subjectId}`;
}

export async function isModerationHidden(
  db: DB,
  subjectType: ReportSubjectType,
  subjectId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ action: moderationActions.action })
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.subjectType, subjectType),
        eq(moderationActions.subjectId, subjectId),
        sql`${moderationActions.action} in ('hide', 'unhide')`,
      ),
    )
    // By `seq`, not by time: see the column's comment. Timestamps neither
    // break ties nor preserve the order decisions were committed in.
    .orderBy(desc(moderationActions.seq))
    .limit(1);
  return row?.action === "hide";
}

export interface ModerationNotice {
  action: "hide";
  reason: string | null;
  at: Date;
}

/**
 * What the owner of a hidden thing is told (PLAN.md §9.4).
 *
 * The Terms say a moderation action comes with a reason and can be appealed.
 * A reason recorded only where operators can read it does not keep that
 * promise, and the hide is deliberately not reversible by its owner — so if
 * they are not told, they are left with a control that silently refuses.
 */
export async function moderationNoticeFor(
  db: DB,
  subjectType: ReportSubjectType,
  subjectId: string,
): Promise<ModerationNotice | null> {
  const [row] = await db
    .select({
      action: moderationActions.action,
      note: moderationActions.note,
      createdAt: moderationActions.createdAt,
    })
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.subjectType, subjectType),
        eq(moderationActions.subjectId, subjectId),
        sql`${moderationActions.action} in ('hide', 'unhide')`,
      ),
    )
    .orderBy(desc(moderationActions.seq))
    .limit(1);
  if (row?.action !== "hide") return null;
  return { action: "hide", reason: row.note, at: row.createdAt };
}

/**
 * Lift a hide.
 *
 * Restores nothing by itself — the pour stays private and the comment stays
 * removed. What it returns is control: the owner can publish the note again if
 * they choose. The system never raises a visibility, an upheld appeal least of
 * all.
 */
export async function unhideSubject(
  db: DB,
  actorId: string,
  subjectType: ReportSubjectType,
  subjectId: string,
  note: string | undefined,
  /**
   * The hide the operator was actually looking at. **Required.**
   *
   * `standing` is computed when the page renders, so a tab left open while
   * another operator lifts one hide and applies the next would submit a
   * reversal of a decision nobody reviewed. The check has to happen under the
   * lock, against the hide in force at that moment — which means the request
   * has to say which one it meant, and an optional guard is one a stale client
   * or a replayed request simply omits.
   */
  expectedActionId: string,
  now = new Date(),
): Promise<void> {
  if (subjectType === "profile") throw new CannotHideProfileError();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${moderationLockKey(subjectType, subjectId)}))`,
    );

    const [current] = await tx
      .select({ id: moderationActions.id, action: moderationActions.action })
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.subjectType, subjectType),
          eq(moderationActions.subjectId, subjectId),
          sql`${moderationActions.action} in ('hide', 'unhide')`,
        ),
      )
      .orderBy(desc(moderationActions.seq))
      .limit(1);
    if (current?.action !== "hide" || current.id !== expectedActionId) {
      throw new StaleModerationViewError();
    }
    if (subjectType === "comment") {
      /**
       * Restore only what the hide actually removed.
       *
       * `applyHide` treats an already-deleted comment as a successful hide —
       * it has to, or two operators on one report produce an error for the
       * second. But that means the row may have been deleted by its author
       * moments earlier, and clearing `deletedAt` unconditionally would
       * republish something somebody deliberately removed. The hide stamps
       * `deletedAt` with the same instant it records, so the two match only
       * when the hide is what set it.
       */
      const standing = await tx
        .select({ createdAt: moderationActions.createdAt })
        .from(moderationActions)
        .where(
          and(
            eq(moderationActions.subjectType, "comment"),
            eq(moderationActions.subjectId, subjectId),
            eq(moderationActions.action, "hide"),
          ),
        )
        .orderBy(desc(moderationActions.seq))
        .limit(1);
      const hiddenAt = standing[0]?.createdAt;
      if (hiddenAt) {
        await tx
          .update(comments)
          .set({ deletedAt: null })
          .where(and(eq(comments.id, subjectId), eq(comments.deletedAt, hiddenAt)));
      }
    }
    await record(tx, actorId, "unhide", subjectType, subjectId, { note }, now);
  });
}

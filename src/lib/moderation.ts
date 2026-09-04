import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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
  tastingNotes,
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
  /** The subject as it reads **now** — which is not necessarily what was reported. */
  preview: string | null;
  /**
   * The subject as it read when the report was filed.
   *
   * Null on reports filed before snapshots existed, which the queue states
   * rather than papering over with the current text.
   */
  reportedPreview: string | null;
  /**
   * Whether the subject as it stands now is something the operator may read.
   *
   * False when it has been deleted, made private, or its author has stepped
   * back. STORYBOARD §3.17 is binding: an operator can hide a thing and
   * suspend an account, but cannot read what was never shared — and a
   * revision written after the content went private was never shared with
   * anyone.
   */
  liveReadable: boolean;
  /**
   * The subject has changed since it was reported.
   *
   * The operator has to be told, because otherwise editing the abuse away is a
   * complete defence: the complaint would describe something the queue no
   * longer shows. False when there is no snapshot to compare against — an
   * unknown is not a difference.
   */
  editedSinceReport: boolean;
  /** The account that owns the reported thing, when there is one. */
  subjectOwnerId: string | null;
  subjectOwnerSuspended: boolean;
  /**
   * Which suspension, so this row's Reinstate cannot lift a newer one.
   *
   * The `suspend` action's id rather than its timestamp: two suspensions can
   * share a millisecond, and then a stale page lifts the wrong one.
   */
  subjectOwnerSuspensionId: string | null;
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
  /**
   * Every read below comes off one snapshot, for the same reason
   * `listSuspendedAccounts` does: this builds each row out of several queries,
   * and a decision landing between two of them yields a row that mixes states
   * — one half describing the world before it and one half after, with the
   * guard values taken from whichever half happened to be read second.
   * Nothing blocks ahead of the first query, so the snapshot is taken when the
   * page starts rather than after a wait.
   */
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read`);
    return listOpenReportsIn(tx, now, limit);
  });
}

async function listOpenReportsIn(
  db: DB,
  now: Date,
  limit: number,
): Promise<QueuedReport[]> {
  const rows = await db
    .select({
      id: reports.id,
      subjectType: reports.subjectType,
      subjectId: reports.subjectId,
      reason: reports.reason,
      subjectSnapshot: reports.subjectSnapshot,
      recordedOwnerId: reports.subjectOwnerId,
      createdAt: reports.createdAt,
      reporterHandle: userProfiles.handle,
    })
    .from(reports)
    .leftJoin(userProfiles, eq(userProfiles.userId, reports.reporterId))
    .where(eq(reports.state, "open"))
    .orderBy(reports.createdAt)
    .limit(limit);
  if (rows.length === 0) return [];

  /**
   * Everything the page needs, in a fixed number of queries.
   *
   * This described each report on its own, which is four or five statements a
   * row — around 500 for a full page. That is the wrong shape anywhere and
   * especially here: the number of rows is the size of the backlog, so the
   * queue got slowest exactly when abuse was arriving fastest, and the tool
   * for responding to it would time out at the moment it was needed. Two
   * rounds now, because the owners are not known until the subjects are read.
   */
  const idsOf = (type: ReportSubjectType) =>
    Array.from(new Set(rows.filter((r) => r.subjectType === type).map((r) => r.subjectId)));
  const commentIds = idsOf("comment");
  const pourIds = idsOf("pour");
  const profileIds = idsOf("profile");

  const [commentRows, pourRows, noteRows] = await Promise.all([
    commentIds.length
      ? db
          .select({
            id: comments.id,
            body: comments.body,
            userId: comments.userId,
            pourId: comments.pourId,
            deletedAt: comments.deletedAt,
          })
          .from(comments)
          .where(inArray(comments.id, commentIds))
      : [],
    pourIds.length
      ? db
          .select({ id: pours.id, userId: pours.userId, visibility: pours.visibility })
          .from(pours)
          .where(inArray(pours.id, pourIds))
      : [],
    pourIds.length
      ? db
          .select({
            pourId: tastingNotes.pourId,
            nose: tastingNotes.nose,
            palate: tastingNotes.palate,
            finish: tastingNotes.finish,
            freeform: tastingNotes.freeform,
          })
          .from(tastingNotes)
          .where(inArray(tastingNotes.pourId, pourIds))
      : [],
  ]);
  const commentById = new Map(commentRows.map((r) => [r.id, r]));
  const pourById = new Map(pourRows.map((r) => [r.id, r]));
  const noteByPour = new Map(noteRows.map((r) => [r.pourId, r]));

  const ownerOf = (row: (typeof rows)[number]): string | null => {
    const live =
      row.subjectType === "comment"
        ? (commentById.get(row.subjectId)?.userId ?? null)
        : row.subjectType === "pour"
          ? (pourById.get(row.subjectId)?.userId ?? null)
          : row.subjectId;
    // The recorded owner is the fallback, because the subject can be hard
    // deleted and the account behind it still has to be reachable.
    return live ?? row.recordedOwnerId ?? null;
  };

  const ownerIds = Array.from(
    new Set([...rows.map(ownerOf).filter((id): id is string => id != null), ...profileIds]),
  );

  /**
   * The pours a reported comment sits under, which are not the reported pours.
   * Needed because a comment is only as visible as its pour, and its pour's
   * *owner* is not necessarily its author.
   */
  const parentPourIds = Array.from(
    new Set(commentRows.map((c) => c.pourId).filter((id) => !pourById.has(id))),
  );
  const parentPourRows = parentPourIds.length
    ? await db
        .select({ id: pours.id, userId: pours.userId, visibility: pours.visibility })
        .from(pours)
        .where(inArray(pours.id, parentPourIds))
    : [];
  // Parent-pour owners join the profile lookup: a comment under a pour whose
  // owner has stepped back is withdrawn with the pour, whatever its own
  // author's settings say.
  for (const p of parentPourRows) ownerIds.push(p.userId);

  const [profileRows, hideActions, suspendActions] = await Promise.all([
    ownerIds.length
      ? db
          .select({
            userId: userProfiles.userId,
            handle: userProfiles.handle,
            displayName: userProfiles.displayName,
            bio: userProfiles.bio,
            socialEnabled: userProfiles.socialEnabled,
            suspendedAt: userProfiles.suspendedAt,
          })
          .from(userProfiles)
          .where(inArray(userProfiles.userId, ownerIds))
      : [],
    latestActionsBySubject(db, "comment", commentIds, ["hide", "unhide"]).then(async (byComment) => {
      const byPour = await latestActionsBySubject(db, "pour", pourIds, ["hide", "unhide"]);
      return { comment: byComment, pour: byPour };
    }),
    latestActionsBySubject(db, "profile", ownerIds, ["suspend", "reinstate"]),
  ]);
  const profileById = new Map(profileRows.map((r) => [r.userId, r]));
  const pourVisibility = new Map<string, { userId: string; visibility: string }>();
  for (const p of [...pourRows, ...parentPourRows]) pourVisibility.set(p.id, p);

  /**
   * Whether the subject is STILL something the operator is allowed to read.
   *
   * `docs/STORYBOARD.md` §3.17 is binding here: "An operator can hide a thing
   * and suspend an account; they cannot read what was never shared." The
   * report-time snapshot is always fair game — the reporter saw it, and it is
   * the evidence the decision is judged on. The *current* text is not: an
   * author who makes their pour private, or switches social off, and then
   * edits, has written something no reporter could ever see, and rendering it
   * under "Now" would hand the operator private content that no complaint is
   * about.
   *
   * So the live projection is gated on the same conditions that made the
   * subject reportable in the first place, rather than on the operator's
   * privileges — which are for acting, not for reading.
   *
   * This deliberately does not delegate to `canViewPourContext`, because it is
   * a different question: that one asks "may *this viewer* see it", and half
   * its answer is friends-and-followers relative to a viewer the queue does
   * not have. This asks "is it still shared with anyone at all". But it must
   * stay **at least as strict** on the parts that are not viewer-relative —
   * the author's `socialEnabled` and the visibility tier — and getting that
   * incomplete is exactly what went wrong on the first attempt, which checked
   * a comment author's switch and never its pour owner's.
   */
  const sharedWithAnyone = (pourId: string): boolean => {
    const pour = pourVisibility.get(pourId);
    if (!pour || pour.visibility === "private") return false;
    // The **pour owner's** switch, which is what `canViewPourContext` keys on
    // before it looks at the tier at all. Checking the comment author's and
    // not the pour owner's was the gap: a comment under a withdrawn pour is
    // withdrawn with it, whatever its own author's settings say.
    return profileById.get(pour.userId)?.socialEnabled === true;
  };

  const stillReadable = (row: (typeof rows)[number]): boolean => {
    if (row.subjectType === "profile") {
      return profileById.get(row.subjectId)?.socialEnabled === true;
    }
    if (row.subjectType === "comment") {
      const comment = commentById.get(row.subjectId);
      if (!comment || comment.deletedAt != null) return false;
      if (!sharedWithAnyone(comment.pourId)) return false;
      // The comment's own author too: strictly stricter than the pour's rule,
      // and a comment by someone who has stepped back should not resurface in
      // an operator's view either.
      return profileById.get(comment.userId)?.socialEnabled === true;
    }
    return sharedWithAnyone(row.subjectId);
  };

  return rows.map(({ subjectSnapshot, recordedOwnerId, ...row }) => {
    const ownerId = ownerOf({ ...row, subjectSnapshot, recordedOwnerId });
    const profile = ownerId ? profileById.get(ownerId) : undefined;

    let preview: string | null = null;
    const readable = stillReadable({ ...row, subjectSnapshot, recordedOwnerId });
    if (!readable) {
      // Nothing to show under "Now", and nothing to compare against either —
      // an unknown is not a difference, the same rule a pre-snapshot report
      // gets.
    } else if (row.subjectType === "comment") {
      preview = commentById.get(row.subjectId)?.body ?? null;
    } else if (row.subjectType === "pour") {
      if (pourById.has(row.subjectId)) {
        const note = noteByPour.get(row.subjectId);
        const text = [note?.nose, note?.palate, note?.finish, note?.freeform]
          .filter(Boolean)
          .join(" · ");
        preview = text ? text : "(no written note)";
      }
    } else {
      const own = profileById.get(row.subjectId);
      preview = own
        ? [`@${own.handle}`, own.displayName, own.bio].filter(Boolean).join(" · ")
        : null;
    }

    const standingSuspension = ownerId ? suspendActions.get(ownerId) : undefined;
    /**
     * "Already handled" means a moderation hide stands — never that the
     * content happens to be out of sight, which an owner could arrange for
     * themselves. For a profile there is no hide, so it means suspended:
     * reading `socialEnabled` would put a moderation label on an account that
     * stepped back of its own accord (US-11).
     */
    const alreadyHidden =
      row.subjectType === "profile"
        ? profileById.get(row.subjectId)?.suspendedAt != null
        : (row.subjectType === "comment" ? hideActions.comment : hideActions.pour).get(
            row.subjectId,
          )?.action === "hide";

    return {
      ...row,
      ageHours: Math.floor((now.getTime() - row.createdAt.getTime()) / 3_600_000),
      preview,
      reportedPreview: subjectSnapshot,
      /**
       * Whether the operator may read the subject as it stands now.
       *
       * False means withdrawn from view — deleted, made private, or its author
       * stepped back — not that it never existed. The queue says which, because
       * "gone" and "no longer yours to read" call for different reading of the
       * same report.
       */
      liveReadable: readable,
      // A subject that has since been deleted reads as `preview: null` while
      // still readable, and that is a change worth flagging: the operator is
      // looking at a report whose target is gone. A subject that is merely out
      // of the operator's reach is NOT flagged edited — an unknown is not a
      // difference, the same rule a pre-snapshot report gets.
      editedSinceReport: readable && subjectSnapshot != null && subjectSnapshot !== preview,
      subjectOwnerId: ownerId,
      subjectOwnerSuspended: profile?.suspendedAt != null,
      subjectOwnerSuspensionId:
        standingSuspension?.action === "suspend" ? standingSuspension.id : null,
      alreadyHidden,
    };
  });
}

/**
 * The newest of `kinds` per subject, in one statement for the whole page.
 *
 * `distinct on` with `order by seq desc` is the same "newest decision wins"
 * rule every single-subject read uses, applied to a set — and it is the
 * sequence, not the timestamp, for the reason the column exists.
 */
async function latestActionsBySubject(
  db: DB,
  subjectType: ReportSubjectType,
  subjectIds: string[],
  kinds: readonly ModerationActionKind[],
): Promise<Map<string, { id: string; action: ModerationActionKind }>> {
  if (subjectIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([moderationActions.subjectId], {
      subjectId: moderationActions.subjectId,
      id: moderationActions.id,
      action: moderationActions.action,
    })
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.subjectType, subjectType),
        inArray(moderationActions.subjectId, subjectIds),
        inArray(moderationActions.action, [...kinds]),
      ),
    )
    .orderBy(moderationActions.subjectId, desc(moderationActions.seq));
  return new Map(rows.map((r) => [r.subjectId, { id: r.id, action: r.action }]));
}

/**
 * Enough of the reported thing to judge it, and nothing more.
 *
 * Used when a report is **filed** (`createReport` stores the result as the
 * report's snapshot). The queue's own reads are bulk-loaded in
 * `listOpenReports`, but they build the same projection from the same columns,
 * so "what was reported" and "what it says now" stay comparable.
 *
 * **Not truncated.** It was capped at 500 characters, which is a reasonable
 * length for a preview and a wrong one for the only view there is: a comment
 * runs to 1,000 characters and a tasting note to 11,000, the queue has no
 * expansion and deliberately no link to the content, and abuse placed after
 * the cutoff would never reach the operator at all. A report the operator
 * cannot read is a report they cannot act on, so the queue scrolls instead.
 */
export async function subjectPreview(
  db: DB,
  subjectType: ReportSubjectType,
  subjectId: string,
): Promise<string | null> {
  if (subjectType === "comment") {
    const row = await db.query.comments.findFirst({
      columns: { body: true },
      where: eq(comments.id, subjectId),
    });
    return row ? row.body : null;
  }
  if (subjectType === "pour") {
    const pour = await db.query.pours.findFirst({
      columns: { id: true },
      where: eq(pours.id, subjectId),
    });
    if (!pour) return null;
    const note = await db.query.tastingNotes.findFirst({
      columns: { nose: true, palate: true, finish: true, freeform: true },
      where: (t, { eq: is }) => is(t.pourId, subjectId),
    });
    const text = [note?.nose, note?.palate, note?.finish, note?.freeform]
      .filter(Boolean)
      .join(" · ");
    return text ? text : "(no written note)";
  }
  const row = await db.query.userProfiles.findFirst({
    columns: { handle: true, displayName: true, bio: true },
    where: eq(userProfiles.userId, subjectId),
  });
  if (!row) return null;
  return [`@${row.handle}`, row.displayName, row.bio].filter(Boolean).join(" · ");
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
      /**
       * No existence check on this branch, deliberately.
       *
       * A standing hide is proof the subject existed, so refusing here because
       * it has since been deleted refuses on the wrong grounds — and it hit
       * the ordinary case: several reports about one pour, the first hidden,
       * the owner then deletes it (`deletePour` is a hard delete), and every
       * remaining report is stuck. The queue offered "Resolve as hidden",
       * because the hide does stand, and the click threw. Those reports could
       * then only be closed by dismissing real complaints as unfounded.
       *
       * The report is still claimed against *this* subject by
       * `resolveOpenReport`, which reads the report row rather than the
       * subject, so nothing here lets a report be closed by an unrelated
       * decision.
       */
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
    /**
     * And the moderation lock, in that order.
     *
     * Reinstatement takes only `moderation:profile`, so with the social-reset
     * lock alone these two paths did not exclude each other and the action-id
     * guard bought nothing: a stale reinstatement could validate suspension A,
     * let B commit, and then clear B — the exact decision-nobody-reviewed the
     * guard exists to refuse. A guard is only as good as the lock the decision
     * it names is read under.
     *
     * `social-reset` first is the global order (`makeEverythingPrivate`,
     * `createPourShare`, `updatePourVisibility`); reversing it here would be
     * the ABBA deadlock.
     */
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${moderationLockKey("profile", userId)}))`,
    );

    /**
     * A suspension over a suspension records nothing, exactly as a hide over a
     * hide does.
     *
     * Several open reports about one account is the ordinary case, and the
     * later ones are genuinely handled by the suspension already in force.
     * Applying a second would overwrite `suspendedAt` and `suspendedReason`
     * with a fresh decision nobody asked for — losing the reason the account
     * was told, and appending a rival `suspend` action for the same state. The
     * first suspension's timestamp is the one that means something, so it is
     * the one kept, and the later report is still resolved.
     */
    const standing = await tx.query.userProfiles.findFirst({
      columns: { suspendedAt: true },
      where: eq(userProfiles.userId, userId),
    });
    if (!standing) throw new UnknownSubjectError();
    if (standing.suspendedAt != null) {
      if (options.reportId) await resolveOpenReport(tx, options.reportId, { ownerId: userId });
      return;
    }

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
   * The suspension the operator was looking at, as the id of the `suspend`
   * action that imposed it. **Required**, for the same reason
   * `unhideSubject`'s is: a guard that can be left out is one a stale client
   * leaves out.
   *
   * This was `suspendedAt`, and a timestamp is not an identity — the third
   * time that mistake has surfaced in this queue. `suspendAccount` overwrites
   * `suspendedAt` with a `now` captured *before* it waits on the lock, so two
   * suspensions serialized behind that lock can carry the same millisecond
   * while differing in reason and in the decision recorded. A page showing the
   * first then satisfied the predicate and lifted the second. The action id is
   * unique by construction and names the decision rather than the moment.
   */
  expectedActionId: string,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${moderationLockKey("profile", userId)}))`,
    );

    const [current] = await tx
      .select({ id: moderationActions.id, action: moderationActions.action })
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.subjectType, "profile"),
          eq(moderationActions.subjectId, userId),
          sql`${moderationActions.action} in ('suspend', 'reinstate')`,
        ),
      )
      .orderBy(desc(moderationActions.seq))
      .limit(1);
    if (current?.action !== "suspend" || current.id !== expectedActionId) {
      const exists = await tx.query.userProfiles.findFirst({
        columns: { userId: true },
        where: eq(userProfiles.userId, userId),
      });
      if (!exists) throw new UnknownSubjectError();
      // Either not suspended, or suspended by a decision this page never
      // showed. Both are "not yours to lift".
      throw new StaleModerationViewError();
    }

    const rows = await tx
      .update(userProfiles)
      .set({ suspendedAt: null, suspendedReason: null, updatedAt: now })
      .where(and(eq(userProfiles.userId, userId), isNotNull(userProfiles.suspendedAt)))
      .returning({ userId: userProfiles.userId });
    if (rows.length === 0) throw new StaleModerationViewError();
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
    columns: { subjectType: true, subjectId: true, subjectOwnerId: true },
    where: and(eq(reports.id, reportId), eq(reports.state, "open")),
  });
  if (!report) throw new ReportAlreadyHandledError();

  const matches =
    "subjectId" in about
      ? report.subjectType === about.subjectType && report.subjectId === about.subjectId
      : /**
         * The owner recorded on the report answers first, and the live subject
         * only as a fallback for reports filed before it was recorded.
         *
         * Asking the subject who owns it fails once the subject is gone —
         * `deletePour` is a hard delete — so suspending the author of a
         * deleted pour could not claim the report about it. The report then had
         * no honest way to close at all: it stayed open past the SLA unless
         * somebody dismissed it as unfounded. Deleting the evidence would have
         * been a way to keep a complaint permanently unresolvable.
         */
        (report.subjectOwnerId ??
          (await reportSubjectOwner(tx, report.subjectType, report.subjectId))) === about.ownerId;
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
  /** Null when the operator's account has since been deleted. */
  actorName: string | null;
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
    // Left, not inner: `actorId` is null once the operator's account is
    // deleted, and an inner join would drop the decision from the trail
    // entirely — trading a delete the schema refused for history that
    // disappears on its own, which is the worse of the two.
    .leftJoin(user, eq(user.id, moderationActions.actorId))
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
  /** Null when the operator's account has since been deleted. */
  actorName: string | null;
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
    // Left, for the reason above and one more: this list carries the only
    // control that lifts a standing hide, so dropping its row would leave the
    // subject hidden with nothing able to unhide it.
    .leftJoin(user, eq(user.id, latest.actorId))
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
  /**
   * The `suspend` action in force, which is what Reinstate names.
   *
   * Null only for a suspension with no recorded action behind it, and then the
   * queue withholds Reinstate rather than lifting a decision it cannot
   * identify.
   */
  suspensionId: string | null;
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
  /**
   * One snapshot for the profile state and the standing action.
   *
   * Read separately, a reinstatement of A followed by a suspension of B
   * landing between the two queries produced a row showing **A's** reason and
   * timestamp with **B's** action id — and that id passes the reinstatement
   * guard, so the operator would have lifted a decision they never reviewed
   * using a guard designed to stop exactly that. Nothing blocks ahead of the
   * first query here, so repeatable read costs nothing and both halves come
   * off one view.
   */
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read`);
    return listSuspendedAccountsIn(tx, limit, options.before);
  });
}

async function listSuspendedAccountsIn(
  db: DB,
  limit: number,
  before: { at: Date; userId: string } | undefined,
): Promise<{ accounts: SuspendedAccount[]; nextCursor: string | null }> {
  const options = { before };
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

  const window = rows.slice(0, limit);
  // One statement for the page, not one per account: the same rule the queue
  // uses, and the id is what Reinstate has to name.
  const standing = await latestActionsBySubject(
    db,
    "profile",
    window.map((r) => r.userId),
    ["suspend", "reinstate"],
  );
  const page = window.map((row) => {
    const current = standing.get(row.userId);
    return {
      ...row,
      suspendedAt: row.suspendedAt as Date,
      suspensionId: current?.action === "suspend" ? current.id : null,
    };
  });
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

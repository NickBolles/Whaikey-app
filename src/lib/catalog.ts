import { and, asc, desc, eq, gt, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DB } from "@/db";
import {
  bottleSubmissions,
  bottleUpcs,
  bottles,
  distilleries,
  userProfiles,
  type Bottle,
  type Relationship,
  type UserBottle,
  type WhiskeyCategory,
} from "@/db/schema";
import { upsertUserBottle } from "@/lib/bar";
import { searchBottles, type BottleSearchResult } from "@/lib/search";

/**
 * The user-submitted half of the catalog (review PLAN-A1).
 *
 * A miss used to be terminal: 269 seeded bottles, no `POST /api/bottles`, and
 * a scan, search or import that found nothing left the user with nowhere to
 * go. This is the submission path; `catalog-visibility.ts` is the rule that
 * keeps a submission private until somebody reviews it.
 */

/**
 * How many bottles one account may add per hour and per day.
 *
 * Generous enough that somebody photographing a real shelf never meets it, low
 * enough that the catalog can't be flooded faster than it can be reviewed.
 */
export const SUBMISSION_LIMIT_PER_HOUR = 20;
export const SUBMISSION_LIMIT_PER_DAY = 60;

export class SubmissionRateLimitedError extends Error {
  constructor() {
    super("Too many bottle submissions");
    this.name = "SubmissionRateLimitedError";
  }
}

export interface BottleSubmissionInput {
  name: string;
  category: WhiskeyCategory;
  /** Free text as typed. Matched against known distilleries; never creates one. */
  distillery?: string;
  country?: string;
  region?: string;
  ageYears?: number;
  abv?: number;
  msrp?: number;
  /** The barcode that missed, when this came out of a scan. */
  upc?: string;
  source?: "scan" | "search" | "import" | "direct";
}

/**
 * Bottles already in the catalog that look like the one being submitted.
 *
 * Runs the ordinary catalog search, so it inherits its alias and typo
 * tolerance — the point is that "Blantons SFB" finds "Blanton's Single Barrel"
 * before a second row for it exists. Duplicates are cheap to prevent here and
 * expensive to merge later.
 */
export async function findSubmissionDuplicates(
  db: DB,
  userId: string,
  name: string,
): Promise<BottleSearchResult[]> {
  const query = name.trim();
  if (!query) return [];
  const exact = await searchBottles(db, query, { viewerId: userId, limit: 5 });
  if (exact.length > 0) return exact;

  // Catalog search requires every token to match, so a submission that differs
  // by one word — "Eagle Rare 17" against "Eagle Rare 10" — finds nothing on
  // the full name. Those are exactly the ones worth showing: not close enough
  // to refuse over, close enough that the user may be about to add a bottle we
  // already have under a slightly different name.
  const head = query.split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
  if (!head || head === query) return exact;
  return searchBottles(db, head, { viewerId: userId, limit: 5 });
}

/** A near-match strong enough to be worth asking about before writing a row. */
export function looksLikeDuplicate(candidate: string, existing: string): boolean {
  return normalizeName(candidate) === normalizeName(existing);
}

function normalizeName(value: string): string {
  return (
    value
      .toLowerCase()
      // Apostrophes vanish rather than becoming a gap: "Blantons" and
      // "Blanton's" are the same bottle typed by two people, and a space here
      // would make them "blantons" and "blanton s".
      .replace(/['\u2019]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  );
}

export interface SubmittedBottle {
  bottle: Bottle;
  submissionId: string;
  /** The shelf row, when the caller asked for one in the same breath. */
  userBottle: UserBottle | null;
}

/**
 * Raised when the name is already in the catalog and the caller has not said
 * it means to add a new one anyway.
 *
 * Thrown from *inside* the write's advisory lock rather than checked before
 * it: two identical requests arriving together would both pass a check made
 * outside, then queue up on the lock and insert one after the other. The
 * prompt has to be the same critical section as the insert or it is only a
 * prompt most of the time.
 */
export class DuplicateBottleError extends Error {
  constructor(readonly duplicates: BottleSearchResult[]) {
    super("A bottle with that name is already in the catalog");
    this.name = "DuplicateBottleError";
  }
}

/**
 * Write a user-submitted bottle and its review-queue row.
 *
 * Rate limiting is a durable count under a per-user advisory lock, the same
 * shape comments and reports use: a burst of concurrent requests must not all
 * read a below-limit count before any of them inserts.
 */
export async function submitBottle(
  db: DB,
  userId: string,
  input: BottleSubmissionInput & {
    /** Set once the user has seen the near-matches and said none of them is it. */
    confirmNew?: boolean;
    /** Put it on the shelf in the same transaction (see below). */
    relationship?: Relationship;
  },
  now = new Date(),
): Promise<SubmittedBottle> {
  const name = input.name.trim();
  const distilleryText = input.distillery?.trim() || null;
  const distilleryId = distilleryText ? await findDistilleryByName(db, distilleryText) : null;

  const bottleId = crypto.randomUUID();
  const submissionId = crypto.randomUUID();

  let userBottle: UserBottle | null = null;
  /**
   * The shelf row is written in the same transaction as the bottle.
   *
   * Split across two, a failure in between left the bottle and its review row
   * committed with no shelf row — and the retry then hit the duplicate-name
   * 409, so the relationship the user asked for could never be applied while
   * the client reported that adding had failed.
   */
  const bottle = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bottle-submit:${userId}`}))`);
    if (!input.confirmNew) {
      const nearby = await findSubmissionDuplicates(tx, userId, name);
      const exact = nearby.filter((b) => looksLikeDuplicate(name, b.name));
      if (exact.length > 0) throw new DuplicateBottleError(exact);
    }
    await assertUnderSubmissionLimit(tx, userId, now);

    const [row] = await tx
      .insert(bottles)
      .values({
        id: bottleId,
        name,
        category: input.category,
        distilleryId,
        country: input.country?.trim() || null,
        region: input.region?.trim() || null,
        ageYears: input.ageYears ?? null,
        abv: input.abv ?? null,
        msrp: input.msrp ?? null,
        status: "user_submitted",
        submittedBy: userId,
      })
      .returning();

    await tx.insert(bottleSubmissions).values({
      id: submissionId,
      bottleId,
      submittedBy: userId,
      // The barcode is recorded on the submission, not as a catalog mapping:
      // a `bottle_upcs` row is crowdsourced truth other people's scans resolve
      // against, and this bottle is not public yet.
      upc: input.upc ?? null,
      source: input.source ?? "direct",
      distilleryText: distilleryId ? null : distilleryText,
    });

    if (input.relationship) {
      const shelf = await upsertUserBottle(tx, userId, {
        bottleId,
        relationship: input.relationship,
      });
      userBottle = shelf.row;
    }

    return row;
  });

  return { bottle, submissionId, userBottle };
}

/**
 * A barcode learned from a submission becomes a catalog mapping only when the
 * bottle is promoted, so this is what the moderation step (WP-18) calls.
 */
export async function publishSubmissionUpc(db: DB, bottleId: string, upc: string): Promise<void> {
  await db
    .insert(bottleUpcs)
    .values({ id: crypto.randomUUID(), upc, bottleId, source: "user", confirmedCount: 1 })
    .onConflictDoNothing();
}

async function findDistilleryByName(db: DB, name: string): Promise<string | null> {
  const [row] = await db
    .select({ id: distilleries.id })
    .from(distilleries)
    .where(sql`lower(${distilleries.name}) = ${name.toLowerCase()}`)
    .limit(1);
  return row?.id ?? null;
}

async function assertUnderSubmissionLimit(tx: DB, userId: string, now: Date): Promise<void> {
  const windows = [
    { since: new Date(now.getTime() - 60 * 60 * 1000), limit: SUBMISSION_LIMIT_PER_HOUR },
    { since: new Date(now.getTime() - 24 * 60 * 60 * 1000), limit: SUBMISSION_LIMIT_PER_DAY },
  ];
  for (const window of windows) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(bottleSubmissions)
      .where(
        and(
          eq(bottleSubmissions.submittedBy, userId),
          gt(bottleSubmissions.createdAt, window.since),
        ),
      );
    if (Number(row?.n ?? 0) >= window.limit) throw new SubmissionRateLimitedError();
  }
}

/** The bottles this user has added, newest first — the "waiting on review" list. */
export async function listOwnSubmissions(db: DB, userId: string, limit = 50) {
  return db
    .select({
      id: bottleSubmissions.id,
      state: bottleSubmissions.state,
      createdAt: bottleSubmissions.createdAt,
      bottleId: bottles.id,
      name: bottles.name,
      category: bottles.category,
    })
    .from(bottleSubmissions)
    .innerJoin(bottles, eq(bottles.id, bottleSubmissions.bottleId))
    .where(eq(bottleSubmissions.submittedBy, userId))
    .orderBy(desc(bottleSubmissions.createdAt))
    .limit(limit);
}

/* -------------------------------------------------------------------------
 * Review (WP-18)
 *
 * WP-16 shipped the submission path and left the other end of it open: rows
 * accumulated in `bottle_submissions` and nothing could promote one, so a
 * submitted bottle stayed private to its submitter indefinitely. This is that
 * end.
 *
 * Catalog review is deliberately NOT recorded in `moderation_actions`. That
 * table's subject types are the social ones (comment, pour, profile), and a
 * submission already has its own append-once record on the row itself —
 * `reviewedBy`, `reviewedAt`, `reviewNote` and, for a duplicate, what it
 * duplicates. Widening a social audit table to carry catalog decisions would
 * make both harder to read and neither more complete.
 * ---------------------------------------------------------------------- */

export interface PendingSubmission {
  id: string;
  bottleId: string;
  name: string;
  category: WhiskeyCategory | null;
  /** The distillery we matched, when the typed name matched one exactly. */
  distilleryName: string | null;
  /** The distillery as typed, parked because it matched nothing. */
  distilleryText: string | null;
  country: string | null;
  region: string | null;
  abv: number | null;
  upc: string | null;
  source: string | null;
  createdAt: Date;
  ageHours: number;
  submittedBy: string;
  submitterHandle: string | null;
}

/**
 * Submissions waiting on review, oldest first.
 *
 * Oldest first for the same reason the report queue is: a newest-first queue
 * is one where the row that has waited longest is the row nobody ever reaches.
 */
export async function listPendingSubmissions(
  db: DB,
  limit = 100,
  now = new Date(),
): Promise<PendingSubmission[]> {
  const rows = await db
    .select({
      id: bottleSubmissions.id,
      bottleId: bottleSubmissions.bottleId,
      name: bottles.name,
      category: bottles.category,
      distilleryName: distilleries.name,
      distilleryText: bottleSubmissions.distilleryText,
      country: bottles.country,
      region: bottles.region,
      abv: bottles.abv,
      upc: bottleSubmissions.upc,
      source: bottleSubmissions.source,
      createdAt: bottleSubmissions.createdAt,
      submittedBy: bottleSubmissions.submittedBy,
      submitterHandle: userProfiles.handle,
    })
    .from(bottleSubmissions)
    .innerJoin(bottles, eq(bottles.id, bottleSubmissions.bottleId))
    .leftJoin(distilleries, eq(distilleries.id, bottles.distilleryId))
    .leftJoin(userProfiles, eq(userProfiles.userId, bottleSubmissions.submittedBy))
    .where(eq(bottleSubmissions.state, "pending"))
    .orderBy(asc(bottleSubmissions.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    ageHours: Math.floor((now.getTime() - row.createdAt.getTime()) / 3_600_000),
  }));
}

export class UnknownSubmissionError extends Error {
  constructor() {
    super("There is no pending submission at that id");
    this.name = "UnknownSubmissionError";
  }
}

/**
 * Promote a submission into the shared catalog.
 *
 * Two writes that must not come apart: the bottle becomes visible to everyone
 * and the submission stops being pending. A barcode that arrived with it
 * becomes a catalog mapping here and nowhere earlier — `bottle_upcs` is
 * crowdsourced truth every other scanner resolves against, so publishing it
 * before a human looked would let one submission answer everybody's scan.
 *
 * Promotion does not touch any pour's visibility. The system never raises a
 * visibility; a pour clamped private while the bottle was pending stays
 * private until its owner says otherwise.
 */
export async function approveSubmission(
  db: DB,
  reviewerId: string,
  submissionId: string,
  note?: string,
  now = new Date(),
): Promise<{ bottleId: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(bottleSubmissions)
      .set({
        state: "approved",
        reviewedBy: reviewerId,
        reviewedAt: now,
        reviewNote: note?.trim() || null,
      })
      .where(and(eq(bottleSubmissions.id, submissionId), eq(bottleSubmissions.state, "pending")))
      .returning({ bottleId: bottleSubmissions.bottleId, upc: bottleSubmissions.upc });
    // The state predicate is the concurrency control: two operators clicking
    // the same row means the second one changes nothing and is told so,
    // rather than re-approving something already decided.
    if (!row) throw new UnknownSubmissionError();

    await tx
      .update(bottles)
      .set({ status: "verified" })
      .where(eq(bottles.id, row.bottleId));

    if (row.upc) await publishSubmissionUpc(tx, row.bottleId, row.upc);
    return { bottleId: row.bottleId };
  });
}

/**
 * Decline a submission.
 *
 * The bottle is not deleted and not taken away from the person who added it:
 * it stays `user_submitted`, which means it stays visible to its submitter and
 * keeps working on their shelf and in their journal. Their records are theirs.
 * What declining withholds is the shared catalog — and the passport, which
 * already excludes `user_submitted` rows for exactly this reason.
 *
 * The reason is required. A decision the submitter cannot be told the grounds
 * for is one nobody can argue with.
 */
export async function rejectSubmission(
  db: DB,
  reviewerId: string,
  submissionId: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  const [row] = await db
    .update(bottleSubmissions)
    .set({ state: "rejected", reviewedBy: reviewerId, reviewedAt: now, reviewNote: reason.trim() })
    .where(and(eq(bottleSubmissions.id, submissionId), eq(bottleSubmissions.state, "pending")))
    .returning({ id: bottleSubmissions.id });
  if (!row) throw new UnknownSubmissionError();
}

/**
 * Record that a submission duplicates a bottle we already have.
 *
 * The target must be a bottle everyone can see — pointing one pending
 * submission at another would record a duplicate of something that may itself
 * never exist. Like a rejection, the submitted row stays private rather than
 * being deleted; re-pointing the submitter's shelf rows and pours at the
 * canonical bottle is a merge, and a merge is not this (PLAN.md §9.4).
 */
export async function markSubmissionDuplicate(
  db: DB,
  reviewerId: string,
  submissionId: string,
  duplicateOfBottleId: string,
  note: string | undefined,
  now = new Date(),
): Promise<void> {
  const target = await db.query.bottles.findFirst({
    columns: { id: true, status: true },
    where: eq(bottles.id, duplicateOfBottleId),
  });
  if (!target || target.status === "user_submitted") throw new UnknownSubmissionError();

  const [row] = await db
    .update(bottleSubmissions)
    .set({
      state: "duplicate",
      duplicateOfBottleId,
      reviewedBy: reviewerId,
      reviewedAt: now,
      reviewNote: note?.trim() || null,
    })
    .where(and(eq(bottleSubmissions.id, submissionId), eq(bottleSubmissions.state, "pending")))
    .returning({ id: bottleSubmissions.id });
  if (!row) throw new UnknownSubmissionError();
}

/** How many submissions are waiting — the queue's own header, and a backlog alarm. */
export async function countPendingSubmissions(db: DB): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(bottleSubmissions)
    .where(eq(bottleSubmissions.state, "pending"));
  return Number(row?.n ?? 0);
}

/**
 * This viewer's own submission of this bottle, when there is one.
 *
 * The review outcome has to be readable by the person who submitted it — a
 * decline writes a required reason, and a reason nobody can read is a reason
 * in name only. Scoped to the submitter: what a reviewer wrote is between
 * them, not something another viewer of the bottle gets to see.
 */
export async function getSubmissionForBottle(
  db: DB,
  bottleId: string,
  userId: string,
): Promise<Pick<
  typeof bottleSubmissions.$inferSelect,
  "id" | "state" | "reviewNote" | "duplicateOfBottleId" | "createdAt"
> | null> {
  const row = await db.query.bottleSubmissions.findFirst({
    columns: {
      id: true,
      state: true,
      reviewNote: true,
      duplicateOfBottleId: true,
      createdAt: true,
    },
    where: and(eq(bottleSubmissions.bottleId, bottleId), eq(bottleSubmissions.submittedBy, userId)),
  });
  return row ?? null;
}

/**
 * Delete unapproved bottles whose submitter's account is gone.
 *
 * `bottles.submittedBy` is `set null` on account deletion, because a bottle
 * already promoted into the shared catalog is data everybody's shelf points at
 * and has to outlive whoever first typed it. But an **unapproved** one is not
 * shared data yet: `catalogVisibleTo` shows a `user_submitted` bottle only to
 * its submitter, so with the submitter null it is visible to nobody — and
 * `bottle_submissions.submittedBy` cascades, so the row that would have put it
 * back in the review queue is gone too. The result is user-entered content
 * that survives the account it belongs to, unreachable and unreviewable,
 * against a Privacy Policy that promises deletion.
 *
 * Swept rather than deleted at the point of account deletion because that path
 * does not exist yet (SEC-M5): today the Privacy Policy describes deletion as
 * a support request, so the cleanup has to be something that catches the
 * result however the account went away, including by hand.
 *
 * Two rows are deliberately spared:
 *
 * - A bottle with a submission row still attached. Its submitter's account may
 *   be gone, but the queue can still see it, and a decision an operator can
 *   still make is not orphaned.
 * - A bottle another submission was marked a **duplicate of**. Not reachable
 *   through the app today — `markSubmissionDuplicate` refuses a target that is
 *   still `user_submitted`, so a duplicate always points at a promoted bottle,
 *   which this sweep never considers. The guard is on the *column*, not on
 *   that rule: `duplicate_of_bottle_id` has no delete policy, so if the rule
 *   ever relaxes the delete would throw and take the rest of the sweep with
 *   it. Skipping a row is a smaller failure than a housekeeping job that stops
 *   at the first one.
 */
export async function sweepOrphanedSubmissions(db: DB): Promise<number> {
  const dupe = alias(bottleSubmissions, "dupe_of");
  const rows = await db
    .delete(bottles)
    .where(
      and(
        eq(bottles.status, "user_submitted"),
        isNull(bottles.submittedBy),
        notExists(
          db
            .select({ one: sql`1` })
            .from(bottleSubmissions)
            .where(eq(bottleSubmissions.bottleId, bottles.id)),
        ),
        notExists(
          db.select({ one: sql`1` }).from(dupe).where(eq(dupe.duplicateOfBottleId, bottles.id)),
        ),
      ),
    )
    .returning({ id: bottles.id });
  return rows.length;
}

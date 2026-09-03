import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { DB } from "@/db";
import {
  bottleSubmissions,
  bottleUpcs,
  bottles,
  distilleries,
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

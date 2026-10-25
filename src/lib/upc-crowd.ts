/**
 * "Teach the scanner": user-confirmed barcodes (M1 / Track A7).
 *
 * When a barcode is unknown, the person picks (or creates) the bottle and
 * their claim is recorded in `upc_confirmations` — **pending**, not live. A
 * claim becomes a `bottle_upcs` mapping (which every other scanner resolves
 * against) only when one of these holds:
 *
 * - `upcConfirmationsRequired()` (default 2) **independent, eligible**
 *   accounts made the same claim, and it leads any competing claim for the
 *   same barcode at least 2:1;
 * - a **trusted** account made it (an operator, or an established account
 *   whose earlier claims were all borne out);
 * - an operator approved it from /admin/catalog/barcodes.
 *
 * Eligible = not suspended and older than `MIN_ACCOUNT_AGE_DAYS`, so a burst
 * of fresh sign-ups cannot out-vote the crowd. Abuse limits: one claim per
 * account per barcode (a changed mind moves the vote), and at most
 * `PENDING_CLAIMS_PER_DAY` new pending claims per account per day.
 */
import { and, count, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { bottleUpcs, upcConfirmations } from "@/db/schema";
import { isOperator } from "@/lib/operator";
import type { BottleSearchResult } from "@/lib/ai/tools";
import { catalogVisibleTo } from "@/lib/catalog-visibility";

const DAY_MS = 86_400_000;

/** Env lookups are injectable for tests; `process.env` satisfies it. */
type Env = Record<string, string | undefined>;

export const MIN_ACCOUNT_AGE_DAYS = 7;
export const PENDING_CLAIMS_PER_DAY = 25;
/** Trusted without an operator: account age and a clean track record. */
export const TRUSTED_ACCOUNT_AGE_DAYS = 30;
export const TRUSTED_MIN_PROMOTED = 5;

export function upcConfirmationsRequired(env: Env = process.env): number {
  const n = Number(env.WHAIKEY_UPC_CONFIRMATIONS_REQUIRED);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 2;
}

export type TeachState =
  /** The barcode now resolves to this bottle for everyone. */
  | "verified"
  /** Recorded; waiting for more confirmations. */
  | "pending"
  /** The mapping already existed; this confirmation strengthened it. */
  | "strengthened"
  /** Too many pending claims today; the shelf add still happened. */
  | "rate_limited";

export interface TeachResult {
  state: TeachState;
  /** Eligible confirmations for this barcode → bottle, including this one when it counts. */
  confirmations: number;
  required: number;
  mapping: schema.BottleUpc | null;
  /** True the moment this person's claim was the one that published the barcode. */
  taught: boolean;
}

interface Actor {
  id: string;
}

async function accountOf(db: DB, userId: string) {
  const [row] = await db
    .select({ createdAt: schema.user.createdAt, suspendedAt: schema.userProfiles.suspendedAt })
    .from(schema.user)
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.user.id))
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row ?? null;
}

/** Operators, and accounts ≥30 days old with ≥5 claims borne out and none rejected. */
export async function isTrustedTeacher(db: DB, actor: Actor, now = new Date()): Promise<boolean> {
  // A fresh object: `isOperator` is a type guard and would narrow `actor` itself to never.
  if (isOperator({ id: actor.id })) return true;
  const acct = await accountOf(db, actor.id);
  if (!acct || acct.suspendedAt) return false;
  if (now.getTime() - acct.createdAt.getTime() < TRUSTED_ACCOUNT_AGE_DAYS * DAY_MS) return false;
  const [row] = await db
    .select({
      promoted: sql<number>`count(*) filter (where ${upcConfirmations.status} = 'promoted')::int`,
      rejected: sql<number>`count(*) filter (where ${upcConfirmations.status} = 'rejected')::int`,
    })
    .from(upcConfirmations)
    .where(eq(upcConfirmations.userId, actor.id));
  return Number(row?.rejected ?? 0) === 0 && Number(row?.promoted ?? 0) >= TRUSTED_MIN_PROMOTED;
}

/**
 * Eligible pending votes per bottle for a barcode: non-suspended accounts
 * older than the minimum age. Rejected votes never count.
 */
export async function eligibleVotes(db: DB, upc: string, now = new Date()): Promise<Map<string, number>> {
  const cutoff = new Date(now.getTime() - MIN_ACCOUNT_AGE_DAYS * DAY_MS);
  const rows = await db
    .select({ bottleId: upcConfirmations.bottleId, n: count() })
    .from(upcConfirmations)
    .innerJoin(schema.user, eq(schema.user.id, upcConfirmations.userId))
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, upcConfirmations.userId))
    .where(
      and(
        eq(upcConfirmations.upc, upc),
        ne(upcConfirmations.status, "rejected"),
        isNull(schema.userProfiles.suspendedAt),
        lte(schema.user.createdAt, cutoff),
      ),
    )
    .groupBy(upcConfirmations.bottleId);
  return new Map(rows.map((r) => [r.bottleId, Number(r.n)]));
}

/** The promotion rule, pure: enough votes, and a clear lead over any competing claim. */
export function shouldPromote(votesFor: number, maxOther: number, required: number): boolean {
  if (votesFor < required) return false;
  return maxOther === 0 || votesFor >= 2 * maxOther;
}

/** Publish barcode → bottle and mark the claims behind it promoted. Idempotent. */
export async function promoteMapping(
  db: DB,
  upc: string,
  bottleId: string,
  confirmations: number,
): Promise<schema.BottleUpc> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(bottleUpcs)
      .values({ id: crypto.randomUUID(), upc, bottleId, source: "user", confirmedCount: Math.max(1, confirmations) })
      .onConflictDoUpdate({
        target: [bottleUpcs.upc, bottleUpcs.bottleId],
        set: { confirmedCount: sql`greatest(${bottleUpcs.confirmedCount}, ${Math.max(1, confirmations)})`, updatedAt: new Date() },
      })
      .returning();
    await tx
      .update(upcConfirmations)
      .set({ status: "promoted", updatedAt: new Date() })
      .where(
        and(
          eq(upcConfirmations.upc, upc),
          eq(upcConfirmations.bottleId, bottleId),
          eq(upcConfirmations.status, "pending"),
        ),
      );
    return row;
  });
}

async function pendingClaimsToday(db: DB, userId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(upcConfirmations)
    .where(
      and(
        eq(upcConfirmations.userId, userId),
        eq(upcConfirmations.status, "pending"),
        gte(upcConfirmations.updatedAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Record `actor`'s confirmation that `upc` is `bottleId`. The caller has
 * already checked the bottle is public (a pending submission holds its
 * barcode on the submission instead).
 */
export async function teachBarcode(
  db: DB,
  actor: Actor,
  upc: string,
  bottleId: string,
  opts: { now?: Date; env?: Env } = {},
): Promise<TeachResult> {
  const now = opts.now ?? new Date();
  const required = upcConfirmationsRequired(opts.env);

  const [existing] = await db
    .select()
    .from(bottleUpcs)
    .where(and(eq(bottleUpcs.upc, upc), eq(bottleUpcs.bottleId, bottleId)))
    .limit(1);
  const [previous] = await db
    .select()
    .from(upcConfirmations)
    .where(and(eq(upcConfirmations.upc, upc), eq(upcConfirmations.userId, actor.id)))
    .limit(1);

  if (previous?.status === "rejected") {
    // An operator ruled this account's claim on this barcode wrong. The
    // rejected row is the moderation record — it keeps the account out of
    // `isTrustedTeacher` — so it is never overwritten by a later claim, for
    // the same bottle or a different one. The shelf add still happens.
    return existing
      ? { state: "strengthened", confirmations: existing.confirmedCount, required, mapping: existing, taught: false }
      : { state: "pending", confirmations: 0, required, mapping: null, taught: false };
  }

  if (existing) {
    // Already known. One confirmation per account, so re-scanning your own
    // bottle every week does not inflate the count others are ordered by.
    if (previous?.bottleId === bottleId) {
      return { state: "strengthened", confirmations: existing.confirmedCount, required, mapping: existing, taught: false };
    }
    await db
      .insert(upcConfirmations)
      .values({ id: crypto.randomUUID(), upc, bottleId, userId: actor.id, status: "promoted", createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [upcConfirmations.upc, upcConfirmations.userId],
        set: { bottleId, status: "promoted", updatedAt: now },
      });
    const [mapping] = await db
      .update(bottleUpcs)
      .set({ confirmedCount: sql`${bottleUpcs.confirmedCount} + 1`, updatedAt: now })
      .where(eq(bottleUpcs.id, existing.id))
      .returning();
    return { state: "strengthened", confirmations: mapping.confirmedCount, required, mapping, taught: false };
  }

  const sameClaim = previous?.bottleId === bottleId && previous.status === "pending";
  if (!sameClaim && (await pendingClaimsToday(db, actor.id, now)) >= PENDING_CLAIMS_PER_DAY) {
    return { state: "rate_limited", confirmations: 0, required, mapping: null, taught: false };
  }

  await db
    .insert(upcConfirmations)
    .values({ id: crypto.randomUUID(), upc, bottleId, userId: actor.id, status: "pending", createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [upcConfirmations.upc, upcConfirmations.userId],
      set: { bottleId, status: "pending", updatedAt: now },
    });

  const votes = await eligibleVotes(db, upc, now);
  const votesFor = votes.get(bottleId) ?? 0;
  const maxOther = Math.max(0, ...[...votes.entries()].filter(([id]) => id !== bottleId).map(([, n]) => n));

  if ((await isTrustedTeacher(db, actor, now)) || shouldPromote(votesFor, maxOther, required)) {
    const mapping = await promoteMapping(db, upc, bottleId, votesFor);
    return { state: "verified", confirmations: Math.max(votesFor, 1), required, mapping, taught: true };
  }
  return { state: "pending", confirmations: votesFor, required, mapping: null, taught: false };
}

export interface CommunitySuggestion extends BottleSearchResult {
  /** Non-rejected claims from non-suspended accounts (any age — this is a suggestion, not a mapping). */
  votes: number;
  /** The viewer made this claim. */
  mine: boolean;
}

/**
 * Pending claims for an unmapped barcode, as pickable suggestions: the
 * viewer's own claim first (so re-scanning your own bottle resolves), then by
 * votes. Only bottles the viewer may see.
 */
export async function communitySuggestions(db: DB, upc: string, viewerId?: string): Promise<CommunitySuggestion[]> {
  const rows = await db
    .select({
      id: schema.bottles.id,
      name: schema.bottles.name,
      category: schema.bottles.category,
      country: schema.bottles.country,
      region: schema.bottles.region,
      ageYears: schema.bottles.ageYears,
      abv: schema.bottles.abv,
      msrp: schema.bottles.msrp,
      avgPrice: schema.bottles.avgPrice,
      distillery: schema.distilleries.name,
      votes: sql<number>`count(*)::int`,
      mine: sql<boolean>`bool_or(${upcConfirmations.userId} = ${viewerId ?? ""})`,
    })
    .from(upcConfirmations)
    .innerJoin(schema.bottles, eq(schema.bottles.id, upcConfirmations.bottleId))
    .leftJoin(schema.distilleries, eq(schema.distilleries.id, schema.bottles.distilleryId))
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, upcConfirmations.userId))
    .where(
      and(
        eq(upcConfirmations.upc, upc),
        eq(upcConfirmations.status, "pending"),
        isNull(schema.userProfiles.suspendedAt),
        catalogVisibleTo(viewerId),
      ),
    )
    .groupBy(schema.bottles.id, schema.distilleries.name)
    // Order before limiting, so the viewer's own claim and the leading
    // suggestion are never cut by an arbitrary group order.
    .orderBy(
      sql`bool_or(${upcConfirmations.userId} = ${viewerId ?? ""}) desc`,
      sql`count(*) desc`,
      schema.bottles.name,
    )
    .limit(5);
  return rows
    .map((r) => ({ ...r, votes: Number(r.votes), mine: Boolean(r.mine) }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || b.votes - a.votes || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Operator moderation (/admin/catalog/barcodes)
// ---------------------------------------------------------------------------

export interface PendingBarcode {
  upc: string;
  bottleId: string;
  bottleName: string;
  votes: number;
  eligibleVotes: number;
  competing: number;
  firstAt: Date;
  lastAt: Date;
}

export async function listPendingBarcodes(db: DB, now = new Date(), limit = 100): Promise<PendingBarcode[]> {
  return listBarcodeClaims(db, "pending", now, limit);
}

/**
 * Claims the crowd (or an operator) already published, newest first, so an
 * operator can still find and reject a wrong live mapping.
 */
export async function listPromotedBarcodes(db: DB, now = new Date(), limit = 50): Promise<PendingBarcode[]> {
  return listBarcodeClaims(db, "promoted", now, limit);
}

async function listBarcodeClaims(
  db: DB,
  status: "pending" | "promoted",
  now: Date,
  limit: number,
): Promise<PendingBarcode[]> {
  const cutoff = new Date(now.getTime() - MIN_ACCOUNT_AGE_DAYS * DAY_MS);
  const rows = await db
    .select({
      upc: upcConfirmations.upc,
      bottleId: upcConfirmations.bottleId,
      bottleName: schema.bottles.name,
      votes: sql<number>`count(*)::int`,
      eligibleVotes: sql<number>`count(*) filter (where ${schema.userProfiles.suspendedAt} is null and ${schema.user.createdAt} <= ${cutoff.toISOString()}::timestamptz)::int`,
      firstAt: sql<Date>`min(${upcConfirmations.createdAt})`,
      lastAt: sql<Date>`max(${upcConfirmations.updatedAt})`,
    })
    .from(upcConfirmations)
    .innerJoin(schema.bottles, eq(schema.bottles.id, upcConfirmations.bottleId))
    .innerJoin(schema.user, eq(schema.user.id, upcConfirmations.userId))
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, upcConfirmations.userId))
    .where(eq(upcConfirmations.status, status))
    .groupBy(upcConfirmations.upc, upcConfirmations.bottleId, schema.bottles.name)
    .orderBy(
      ...(status === "pending"
        ? [sql`count(*) desc`, sql`max(${upcConfirmations.updatedAt}) desc`]
        : [sql`max(${upcConfirmations.updatedAt}) desc`]),
    )
    .limit(limit);
  const upcs = [...new Set(rows.map((r) => r.upc))];
  const perUpc = new Map<string, number>();
  if (upcs.length > 0) {
    const counts = await db
      .select({ upc: upcConfirmations.upc, n: sql<number>`count(distinct ${upcConfirmations.bottleId})::int` })
      .from(upcConfirmations)
      .where(and(inArray(upcConfirmations.upc, upcs), eq(upcConfirmations.status, "pending")))
      .groupBy(upcConfirmations.upc);
    for (const c of counts) perUpc.set(c.upc, Number(c.n));
  }
  return rows.map((r) => ({
    ...r,
    votes: Number(r.votes),
    eligibleVotes: Number(r.eligibleVotes),
    competing: Math.max(0, (perUpc.get(r.upc) ?? 1) - 1),
    firstAt: new Date(r.firstAt),
    lastAt: new Date(r.lastAt),
  }));
}

/** Operator approval: publish now, regardless of the vote count. */
export async function approvePendingBarcode(db: DB, upc: string, bottleId: string): Promise<schema.BottleUpc | null> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(upcConfirmations)
    .where(and(eq(upcConfirmations.upc, upc), eq(upcConfirmations.bottleId, bottleId), eq(upcConfirmations.status, "pending")));
  if (Number(n) === 0) return null;
  return promoteMapping(db, upc, bottleId, Number(n));
}

/**
 * Operator rejection: the claims stop counting (and count against their
 * authors' trust), and a crowd-published mapping for the pair is withdrawn.
 * Seed/import mappings are not touched — those are fixed at the source.
 */
export async function rejectBarcodeClaim(db: DB, upc: string, bottleId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(upcConfirmations)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(and(eq(upcConfirmations.upc, upc), eq(upcConfirmations.bottleId, bottleId), ne(upcConfirmations.status, "rejected")))
      .returning({ id: upcConfirmations.id });
    await tx
      .delete(bottleUpcs)
      .where(and(eq(bottleUpcs.upc, upc), eq(bottleUpcs.bottleId, bottleId), eq(bottleUpcs.source, "user")));
    return updated.length;
  });
}

/**
 * Social core library (docs/SOCIAL.md — binding).
 *
 * Every cross-user read in this file goes through an explicit column
 * projection (the getPublicPourShare pattern in src/lib/pour-sharing.ts) and
 * enforces, in order: the author's userProfiles.socialEnabled, blocks in both
 * directions, then the pour's visibility tier — except the object's owner,
 * who always sees their own data. purchasePrice, estValue, amountMl, pour
 * context, and pour/note counts on a *person* never appear in a cross-user
 * shape; cheers/comment counts render on the object only (docs/SOCIAL.md §3.3).
 *
 * A signed-out viewer (viewerId === null) sees nothing cross-user — share
 * links (src/lib/pour-sharing.ts) are a separate bearer-token mechanism.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type AnyColumn } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { REPORT_SUBJECT_TYPES, type FollowState, type PourVisibility, type ReportSubjectType } from "@/db/schema";
import { getUserPalate } from "@/lib/palate-store";
import { palateWheelHeat } from "@/lib/palate";
import { RESERVED_HANDLES } from "@/lib/reserved-handles";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface SocialProfile {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  homeRegion: string | null;
  isPublic: boolean;
  discoverable: boolean;
  socialEnabled: boolean;
  createdAt: Date;
}

export interface ProfileSummary {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** Lowercase + trim; the only normalization handles ever go through. */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(normalizeHandle(handle));
}

export class HandleTakenError extends Error {
  constructor(handle: string) {
    super(`Handle already taken: "${handle}"`);
    this.name = "HandleTakenError";
  }
}

export class InvalidHandleError extends Error {
  constructor(handle: string) {
    super(`Invalid or reserved handle: "${handle}"`);
    this.name = "InvalidHandleError";
  }
}

function toSocialProfile(row: typeof schema.userProfiles.$inferSelect): SocialProfile {
  return {
    userId: row.userId,
    handle: row.handle,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    bio: row.bio,
    homeRegion: row.homeRegion,
    isPublic: row.isPublic,
    discoverable: row.discoverable,
    socialEnabled: row.socialEnabled,
    createdAt: row.createdAt,
  };
}

function toProfileSummary(row: {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}): ProfileSummary {
  return { userId: row.userId, handle: row.handle, displayName: row.displayName, avatarUrl: row.avatarUrl };
}

export async function getOwnProfile(db: DB, userId: string): Promise<SocialProfile | null> {
  const row = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, userId) });
  return row ? toSocialProfile(row) : null;
}

/**
 * Claim a handle for a user (lazily, at first social action — never at
 * signup). Throws InvalidHandleError for a malformed or reserved handle,
 * HandleTakenError for a handle already claimed (pre-checked, then
 * re-verified against the unique constraint to close the race).
 */
export async function createProfile(
  db: DB,
  user: { id: string; name: string; image?: string | null },
  handle: string,
): Promise<SocialProfile> {
  const normalized = normalizeHandle(handle);
  if (!isValidHandle(normalized) || isReservedHandle(normalized)) {
    throw new InvalidHandleError(handle);
  }

  const existing = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.handle, normalized) });
  if (existing) throw new HandleTakenError(normalized);

  const inserted = await db
    .insert(schema.userProfiles)
    .values({
      userId: user.id,
      handle: normalized,
      displayName: user.name,
      avatarUrl: user.image ?? null,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (!row) throw new HandleTakenError(normalized);
  return toSocialProfile(row);
}

export async function updateProfile(
  db: DB,
  userId: string,
  patch: Partial<Pick<SocialProfile, "displayName" | "bio" | "homeRegion" | "isPublic" | "discoverable">>,
): Promise<SocialProfile | null> {
  const values: Partial<typeof schema.userProfiles.$inferInsert> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) values.displayName = patch.displayName;
  if (patch.bio !== undefined) values.bio = patch.bio;
  if (patch.homeRegion !== undefined) values.homeRegion = patch.homeRegion;
  if (patch.isPublic !== undefined) values.isPublic = patch.isPublic;
  if (patch.discoverable !== undefined) values.discoverable = patch.discoverable;

  const rows = await db
    .update(schema.userProfiles)
    .set(values)
    .where(eq(schema.userProfiles.userId, userId))
    .returning();
  return rows[0] ? toSocialProfile(rows[0]) : null;
}

/** docs/SOCIAL.md §11: no links in bios until there's a reason. */
const LINKISH = /(?:https?:\/\/|www\.|\S+\.(?:com|net|org|io|app|co|xyz|me|link|bar|shop|site)\b)/i;
const bioSchema = z
  .string()
  .trim()
  .max(280)
  .refine((v) => !LINKISH.test(v), { message: "Links aren't allowed in bios" });

export const profileCreateSchema = z.object({
  handle: z.string().min(1).max(40),
  displayName: z.string().trim().min(1).max(80).optional(),
  bio: bioSchema.optional(),
  homeRegion: z.string().trim().max(80).optional(),
  isPublic: z.boolean().optional(),
  discoverable: z.boolean().optional(),
});

export const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  bio: bioSchema.nullable().optional(),
  homeRegion: z.string().trim().max(80).nullable().optional(),
  isPublic: z.boolean().optional(),
  discoverable: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export type FollowResult = { state: FollowState } | null;

/** Users blocked by `userId` in either direction, keyed by the counterpart id. */
async function getBlockedCounterparts(db: DB, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ blockerId: schema.blocks.blockerId, blockedId: schema.blocks.blockedId })
    .from(schema.blocks)
    .where(or(eq(schema.blocks.blockerId, userId), eq(schema.blocks.blockedId, userId)));
  const set = new Set<string>();
  for (const row of rows) set.add(row.blockerId === userId ? row.blockedId : row.blockerId);
  return set;
}

async function getAcceptedFolloweeIds(db: DB, userId: string): Promise<string[]> {
  const rows = await db
    .select({ followeeId: schema.follows.followeeId })
    .from(schema.follows)
    .where(and(eq(schema.follows.followerId, userId), eq(schema.follows.state, "accepted")));
  return rows.map((r) => r.followeeId);
}

/**
 * Follow (or request to follow) a user by handle. Returns null when the
 * target doesn't exist, has socialEnabled=false, is the caller, or either
 * party has blocked the other — all indistinguishable to the caller by
 * design. Idempotent: an existing edge returns its current state unchanged.
 */
export async function followByHandle(db: DB, followerId: string, handle: string): Promise<FollowResult> {
  const target = await db.query.userProfiles.findFirst({
    where: eq(schema.userProfiles.handle, normalizeHandle(handle)),
  });
  if (!target) return null;
  if (target.userId === followerId) return null;
  if (!target.socialEnabled) return null;
  if (await isBlockedEither(db, followerId, target.userId)) return null;

  const existing = await db.query.follows.findFirst({
    where: and(eq(schema.follows.followerId, followerId), eq(schema.follows.followeeId, target.userId)),
  });
  if (existing) return { state: existing.state };

  const state: FollowState = target.isPublic ? "accepted" : "pending";
  const inserted = await db
    .insert(schema.follows)
    .values({ id: crypto.randomUUID(), followerId, followeeId: target.userId, state })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { state: inserted[0].state };

  const raced = await db.query.follows.findFirst({
    where: and(eq(schema.follows.followerId, followerId), eq(schema.follows.followeeId, target.userId)),
  });
  return raced ? { state: raced.state } : null;
}

export async function unfollow(db: DB, followerId: string, followeeId: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.follows)
    .where(and(eq(schema.follows.followerId, followerId), eq(schema.follows.followeeId, followeeId)))
    .returning({ id: schema.follows.id });
  return deleted.length > 0;
}

export async function approveFollow(db: DB, followeeId: string, followerId: string): Promise<boolean> {
  const updated = await db
    .update(schema.follows)
    .set({ state: "accepted" })
    .where(
      and(
        eq(schema.follows.followeeId, followeeId),
        eq(schema.follows.followerId, followerId),
        eq(schema.follows.state, "pending"),
      ),
    )
    .returning({ id: schema.follows.id });
  return updated.length > 0;
}

export async function denyFollow(db: DB, followeeId: string, followerId: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.follows)
    .where(
      and(
        eq(schema.follows.followeeId, followeeId),
        eq(schema.follows.followerId, followerId),
        eq(schema.follows.state, "pending"),
      ),
    )
    .returning({ id: schema.follows.id });
  return deleted.length > 0;
}

export async function removeFollower(db: DB, followeeId: string, followerId: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.follows)
    .where(
      and(
        eq(schema.follows.followeeId, followeeId),
        eq(schema.follows.followerId, followerId),
        eq(schema.follows.state, "accepted"),
      ),
    )
    .returning({ id: schema.follows.id });
  return deleted.length > 0;
}

export async function listFollowing(
  db: DB,
  userId: string,
): Promise<Array<ProfileSummary & { state: FollowState }>> {
  const rows = await db
    .select({
      userId: schema.userProfiles.userId,
      handle: schema.userProfiles.handle,
      displayName: schema.userProfiles.displayName,
      avatarUrl: schema.userProfiles.avatarUrl,
      state: schema.follows.state,
    })
    .from(schema.follows)
    .innerJoin(schema.userProfiles, eq(schema.follows.followeeId, schema.userProfiles.userId))
    .where(
      and(
        eq(schema.follows.followerId, userId),
        eq(schema.userProfiles.socialEnabled, true),
        // Belt and braces: blockUser deletes the edges, but a follow racing a
        // block can recreate one — the read path never shows a blocked pair.
        contributorVisibleSql(schema.follows.followeeId, userId),
      ),
    )
    .orderBy(desc(schema.follows.createdAt));
  return rows.map((r) => ({ ...toProfileSummary(r), state: r.state }));
}

export async function listFollowers(db: DB, userId: string): Promise<ProfileSummary[]> {
  const rows = await db
    .select({
      userId: schema.userProfiles.userId,
      handle: schema.userProfiles.handle,
      displayName: schema.userProfiles.displayName,
      avatarUrl: schema.userProfiles.avatarUrl,
    })
    .from(schema.follows)
    .innerJoin(schema.userProfiles, eq(schema.follows.followerId, schema.userProfiles.userId))
    .where(
      and(
        eq(schema.follows.followeeId, userId),
        eq(schema.follows.state, "accepted"),
        eq(schema.userProfiles.socialEnabled, true),
        contributorVisibleSql(schema.follows.followerId, userId),
      ),
    )
    .orderBy(desc(schema.follows.createdAt));
  return rows.map(toProfileSummary);
}

export async function listFollowRequests(db: DB, userId: string): Promise<ProfileSummary[]> {
  const rows = await db
    .select({
      userId: schema.userProfiles.userId,
      handle: schema.userProfiles.handle,
      displayName: schema.userProfiles.displayName,
      avatarUrl: schema.userProfiles.avatarUrl,
    })
    .from(schema.follows)
    .innerJoin(schema.userProfiles, eq(schema.follows.followerId, schema.userProfiles.userId))
    .where(
      and(
        eq(schema.follows.followeeId, userId),
        eq(schema.follows.state, "pending"),
        eq(schema.userProfiles.socialEnabled, true),
        contributorVisibleSql(schema.follows.followerId, userId),
      ),
    )
    .orderBy(desc(schema.follows.createdAt));
  return rows.map(toProfileSummary);
}

export async function areFriends(db: DB, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const rows = await db
    .select({ id: schema.follows.id })
    .from(schema.follows)
    .where(
      or(
        and(eq(schema.follows.followerId, a), eq(schema.follows.followeeId, b), eq(schema.follows.state, "accepted")),
        and(eq(schema.follows.followerId, b), eq(schema.follows.followeeId, a), eq(schema.follows.state, "accepted")),
      ),
    );
  return rows.length === 2;
}

/** Idempotent; deletes any follow rows between the pair, both directions, in one transaction. */
export async function blockUser(db: DB, blockerId: string, blockedId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.blocks)
      .values({ id: crypto.randomUUID(), blockerId, blockedId })
      .onConflictDoNothing();
    await tx
      .delete(schema.follows)
      .where(
        or(
          and(eq(schema.follows.followerId, blockerId), eq(schema.follows.followeeId, blockedId)),
          and(eq(schema.follows.followerId, blockedId), eq(schema.follows.followeeId, blockerId)),
        ),
      );
  });
}

export async function unblockUser(db: DB, blockerId: string, blockedId: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.blocks)
    .where(and(eq(schema.blocks.blockerId, blockerId), eq(schema.blocks.blockedId, blockedId)))
    .returning({ id: schema.blocks.id });
  return deleted.length > 0;
}

/**
 * Users this user has blocked. Falls back to the base user record when the
 * blocked party has no social profile (blocking never requires one).
 */
export async function listBlocked(db: DB, userId: string): Promise<ProfileSummary[]> {
  const rows = await db
    .select({
      userId: schema.user.id,
      userName: schema.user.name,
      userImage: schema.user.image,
      handle: schema.userProfiles.handle,
      displayName: schema.userProfiles.displayName,
      avatarUrl: schema.userProfiles.avatarUrl,
    })
    .from(schema.blocks)
    .innerJoin(schema.user, eq(schema.blocks.blockedId, schema.user.id))
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.blocks.blockedId))
    .where(eq(schema.blocks.blockerId, userId))
    .orderBy(desc(schema.blocks.createdAt));
  return rows.map((r) => ({
    userId: r.userId,
    handle: r.handle ?? r.userId,
    displayName: r.displayName ?? r.userName,
    avatarUrl: r.avatarUrl ?? r.userImage ?? null,
  }));
}

export async function isBlockedEither(db: DB, a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.blocks.id })
    .from(schema.blocks)
    .where(
      or(
        and(eq(schema.blocks.blockerId, a), eq(schema.blocks.blockedId, b)),
        and(eq(schema.blocks.blockerId, b), eq(schema.blocks.blockedId, a)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Prefs & the step-back switch
// ---------------------------------------------------------------------------

export interface SocialPrefs {
  defaultPourVisibility: PourVisibility;
  allowComments: boolean;
}

const DEFAULT_SOCIAL_PREFS: SocialPrefs = { defaultPourVisibility: "private", allowComments: true };

export async function getSocialPrefs(db: DB, userId: string): Promise<SocialPrefs> {
  const row = await db.query.userSocialPrefs.findFirst({ where: eq(schema.userSocialPrefs.userId, userId) });
  if (!row) return { ...DEFAULT_SOCIAL_PREFS };
  return { defaultPourVisibility: row.defaultPourVisibility, allowComments: row.allowComments };
}

export async function updateSocialPrefs(db: DB, userId: string, patch: Partial<SocialPrefs>): Promise<SocialPrefs> {
  // Write only the supplied columns: a read-merge-write of the whole row lets
  // two concurrent patches (e.g. two tabs) restore each other's stale values —
  // dangerous when the clobbered field is defaultPourVisibility.
  const set: Partial<typeof schema.userSocialPrefs.$inferInsert> = { updatedAt: new Date() };
  if (patch.defaultPourVisibility !== undefined) set.defaultPourVisibility = patch.defaultPourVisibility;
  if (patch.allowComments !== undefined) set.allowComments = patch.allowComments;
  await db
    .insert(schema.userSocialPrefs)
    .values({
      userId,
      ...(patch.defaultPourVisibility !== undefined ? { defaultPourVisibility: patch.defaultPourVisibility } : {}),
      ...(patch.allowComments !== undefined ? { allowComments: patch.allowComments } : {}),
    })
    .onConflictDoUpdate({ target: schema.userSocialPrefs.userId, set });
  return getSocialPrefs(db, userId);
}

/**
 * US-11: one transaction — every pour goes private, every share link is
 * revoked, the profile is unlisted (socialEnabled/isPublic/discoverable all
 * false), and the default visibility pref resets to private. Deletes
 * nothing; fully reversible by re-editing the profile.
 */
export async function makeEverythingPrivate(db: DB, userId: string): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    // Shared with createPourShare: a share request must fully serialize with
    // the reset so it can't mint a live bearer link mid-reset.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`social-reset:${userId}`}))`);
    await tx.update(schema.pours).set({ visibility: "private" }).where(eq(schema.pours.userId, userId));
    await tx
      .update(schema.pourShares)
      .set({ revokedAt: now })
      .where(and(eq(schema.pourShares.userId, userId), isNull(schema.pourShares.revokedAt)));
    await tx
      .update(schema.userProfiles)
      .set({ socialEnabled: false, isPublic: false, discoverable: false, updatedAt: now })
      .where(eq(schema.userProfiles.userId, userId));
    await tx
      .insert(schema.userSocialPrefs)
      .values({ userId, defaultPourVisibility: "private" })
      .onConflictDoUpdate({
        target: schema.userSocialPrefs.userId,
        set: { defaultPourVisibility: "private", updatedAt: now },
      });
  });
}

/**
 * The reversible half of the US-11 step-back switch: turning social back on
 * restores nothing else — pours stay private, revoked links stay revoked, and
 * the profile stays non-public until the owner explicitly changes each one.
 */
export async function setSocialEnabled(db: DB, userId: string, enabled: boolean): Promise<boolean> {
  const rows = await db
    .update(schema.userProfiles)
    .set({ socialEnabled: enabled, updatedAt: new Date() })
    .where(eq(schema.userProfiles.userId, userId))
    .returning({ userId: schema.userProfiles.userId });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Visibility & projections
// ---------------------------------------------------------------------------

interface PourAuthContext {
  pourId: string;
  authorId: string;
  visibility: PourVisibility;
  authorSocialEnabled: boolean;
}

async function loadPourAuthContext(db: DB, pourId: string): Promise<PourAuthContext | null> {
  const rows = await db
    .select({
      pourId: schema.pours.id,
      authorId: schema.pours.userId,
      visibility: schema.pours.visibility,
      authorSocialEnabled: schema.userProfiles.socialEnabled,
    })
    .from(schema.pours)
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.pours.userId))
    .where(eq(schema.pours.id, pourId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    pourId: row.pourId,
    authorId: row.authorId,
    visibility: row.visibility,
    authorSocialEnabled: row.authorSocialEnabled ?? false,
  };
}

/**
 * The one visibility decision every cross-user read shares. Owner always
 * passes; otherwise author.socialEnabled, then blocks (both directions), then
 * the pour's visibility tier, strictly in that order.
 */
async function canViewPourContext(db: DB, viewerId: string | null, ctx: PourAuthContext): Promise<boolean> {
  if (viewerId != null && viewerId === ctx.authorId) return true;
  if (!ctx.authorSocialEnabled) return false;
  if (viewerId == null) return false;
  if (await isBlockedEither(db, viewerId, ctx.authorId)) return false;

  switch (ctx.visibility) {
    case "private":
      return false;
    case "friends":
      return areFriends(db, viewerId, ctx.authorId);
    case "followers": {
      const row = await db.query.follows.findFirst({
        where: and(
          eq(schema.follows.followerId, viewerId),
          eq(schema.follows.followeeId, ctx.authorId),
          eq(schema.follows.state, "accepted"),
        ),
      });
      return Boolean(row);
    }
    case "public":
      return true;
    default:
      return false;
  }
}

export async function canViewPour(db: DB, viewerId: string | null, pourId: string): Promise<boolean> {
  const ctx = await loadPourAuthContext(db, pourId);
  if (!ctx) return false;
  return canViewPourContext(db, viewerId, ctx);
}

export interface SocialNote {
  pourId: string;
  bottleId: string;
  bottleName: string;
  author: ProfileSummary;
  rating: number | null;
  servingStyle: string | null;
  createdAt: Date;
  visibility: PourVisibility;
  nose: string | null;
  palate: string | null;
  finish: string | null;
  freeform: string | null;
  flavorTags: Record<string, number> | null;
  cheersCount: number;
  commentCount: number;
  viewerCheered: boolean;
}

/**
 * SQL predicate: the contribution's author (`userCol`) is visible to the
 * viewer — not blocked in either direction, and not stepped back
 * (userProfiles.socialEnabled=false hides a user's cheers, comments, and
 * graph rows from everyone but themself; US-11). Every count rendered next
 * to a thread or card must use this so counts agree with the visible thread —
 * a mismatched count would reveal hidden activity.
 */
function contributorVisibleSql(userCol: AnyColumn, viewerId: string) {
  return sql`(${userCol} = ${viewerId} or (
    not exists (select 1 from blocks b where (b.blocker_id = ${viewerId} and b.blocked_id = ${userCol}) or (b.blocker_id = ${userCol} and b.blocked_id = ${viewerId}))
    and not exists (select 1 from user_profiles sp where sp.user_id = ${userCol} and sp.social_enabled = false)
  ))`;
}

async function countCheers(db: DB, pourId: string, viewerId: string | null): Promise<number> {
  const conditions = [eq(schema.reactions.pourId, pourId), eq(schema.reactions.kind, "cheers")];
  if (viewerId) conditions.push(contributorVisibleSql(schema.reactions.userId, viewerId));
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.reactions)
    .where(and(...conditions));
  return Number(rows[0]?.n ?? 0);
}

async function countComments(db: DB, pourId: string, viewerId: string | null): Promise<number> {
  const conditions = [eq(schema.comments.pourId, pourId), isNull(schema.comments.deletedAt)];
  if (viewerId) conditions.push(contributorVisibleSql(schema.comments.userId, viewerId));
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.comments)
    .where(and(...conditions));
  return Number(rows[0]?.n ?? 0);
}

async function hasCheered(db: DB, userId: string, pourId: string): Promise<boolean> {
  const row = await db.query.reactions.findFirst({
    where: and(eq(schema.reactions.pourId, pourId), eq(schema.reactions.userId, userId), eq(schema.reactions.kind, "cheers")),
  });
  return Boolean(row);
}

interface RawNoteRow {
  pourId: string;
  bottleId: string;
  bottleName: string;
  rating: number | null;
  servingStyle: string | null;
  createdAt: Date;
  visibility: PourVisibility;
  nose: string | null;
  palate: string | null;
  finish: string | null;
  freeform: string | null;
  flavorTags: Record<string, number> | null;
}

async function toSocialNote(
  db: DB,
  viewerId: string | null,
  row: RawNoteRow,
  author: ProfileSummary,
): Promise<SocialNote> {
  const [cheersCount, commentCount, viewerCheered] = await Promise.all([
    countCheers(db, row.pourId, viewerId),
    countComments(db, row.pourId, viewerId),
    viewerId ? hasCheered(db, viewerId, row.pourId) : Promise.resolve(false),
  ]);
  return {
    pourId: row.pourId,
    bottleId: row.bottleId,
    bottleName: row.bottleName,
    author,
    rating: row.rating,
    servingStyle: row.servingStyle,
    createdAt: row.createdAt,
    visibility: row.visibility,
    nose: row.nose,
    palate: row.palate,
    finish: row.finish,
    freeform: row.freeform,
    flavorTags: row.flavorTags,
    cheersCount,
    commentCount,
    viewerCheered,
  };
}

/** The single cross-user pour projection — the /notes/[pourId] source. */
export async function getSocialNote(db: DB, viewerId: string | null, pourId: string): Promise<SocialNote | null> {
  const rows = await db
    .select({
      pourId: schema.pours.id,
      bottleId: schema.pours.bottleId,
      bottleName: schema.bottles.name,
      authorId: schema.pours.userId,
      authorHandle: schema.userProfiles.handle,
      authorDisplayName: schema.userProfiles.displayName,
      authorAvatarUrl: schema.userProfiles.avatarUrl,
      authorSocialEnabled: schema.userProfiles.socialEnabled,
      rating: schema.pours.rating,
      servingStyle: schema.pours.servingStyle,
      createdAt: schema.pours.createdAt,
      visibility: schema.pours.visibility,
      nose: schema.tastingNotes.nose,
      palate: schema.tastingNotes.palate,
      finish: schema.tastingNotes.finish,
      freeform: schema.tastingNotes.freeform,
      flavorTags: schema.tastingNotes.flavorTags,
    })
    .from(schema.pours)
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.pours.userId))
    .leftJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(eq(schema.pours.id, pourId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const ctx: PourAuthContext = {
    pourId: row.pourId,
    authorId: row.authorId,
    visibility: row.visibility,
    authorSocialEnabled: row.authorSocialEnabled ?? false,
  };
  if (!(await canViewPourContext(db, viewerId, ctx))) return null;
  if (!row.authorHandle) return null; // no profile => not socially reachable (guards the type below)

  return toSocialNote(db, viewerId, row, {
    userId: row.authorId,
    handle: row.authorHandle,
    displayName: row.authorDisplayName ?? "",
    avatarUrl: row.authorAvatarUrl,
  });
}

export interface FeedItem extends SocialNote {
  viewerTags: Record<string, number> | null;
  viewerTriedBottle: boolean;
  viewerBottleRelationship: "own" | "tried" | "wishlist" | null;
}

/**
 * Pours (with a rating or a tasting note) authored by users the viewer
 * follows (accepted), newest first, visibility-checked per pour, blocks
 * excluded, socialEnabled=false authors excluded. viewerTags is the union of
 * the viewer's own flavorTags on the same bottle ("you tasted this too").
 */
export async function getFriendFeed(db: DB, viewerId: string, opts: { limit?: number } = {}): Promise<FeedItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  const blocked = await getBlockedCounterparts(db, viewerId);
  const followeeIds = (await getAcceptedFolloweeIds(db, viewerId)).filter((id) => !blocked.has(id));
  if (followeeIds.length === 0) return [];

  const followsBackRows = await db
    .select({ followerId: schema.follows.followerId })
    .from(schema.follows)
    .where(
      and(
        inArray(schema.follows.followerId, followeeIds),
        eq(schema.follows.followeeId, viewerId),
        eq(schema.follows.state, "accepted"),
      ),
    );
  const friendIds = followsBackRows.map((r) => r.followerId);

  const visibilityCond =
    friendIds.length > 0
      ? or(
          inArray(schema.pours.visibility, ["followers", "public"]),
          and(eq(schema.pours.visibility, "friends"), inArray(schema.pours.userId, friendIds)),
        )
      : inArray(schema.pours.visibility, ["followers", "public"]);

  const rows = await db
    .select({
      pourId: schema.pours.id,
      bottleId: schema.pours.bottleId,
      bottleName: schema.bottles.name,
      authorId: schema.pours.userId,
      authorHandle: schema.userProfiles.handle,
      authorDisplayName: schema.userProfiles.displayName,
      authorAvatarUrl: schema.userProfiles.avatarUrl,
      rating: schema.pours.rating,
      servingStyle: schema.pours.servingStyle,
      createdAt: schema.pours.createdAt,
      visibility: schema.pours.visibility,
      nose: schema.tastingNotes.nose,
      palate: schema.tastingNotes.palate,
      finish: schema.tastingNotes.finish,
      freeform: schema.tastingNotes.freeform,
      flavorTags: schema.tastingNotes.flavorTags,
      noteId: schema.tastingNotes.id,
    })
    .from(schema.pours)
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .innerJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.pours.userId))
    .leftJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(
      and(
        inArray(schema.pours.userId, followeeIds),
        eq(schema.userProfiles.socialEnabled, true),
        visibilityCond,
        or(isNotNull(schema.pours.rating), isNotNull(schema.tastingNotes.id)),
      ),
    )
    .orderBy(desc(schema.pours.createdAt), desc(schema.pours.id))
    .limit(limit);
  if (rows.length === 0) return [];

  const pourIds = rows.map((r) => r.pourId);
  const bottleIds = [...new Set(rows.map((r) => r.bottleId))];

  const cheersRows = await db
    .select({ pourId: schema.reactions.pourId, n: sql<number>`count(*)` })
    .from(schema.reactions)
    .where(
      and(
        inArray(schema.reactions.pourId, pourIds),
        eq(schema.reactions.kind, "cheers"),
        contributorVisibleSql(schema.reactions.userId, viewerId),
      ),
    )
    .groupBy(schema.reactions.pourId);
  const cheersMap = new Map(cheersRows.map((r) => [r.pourId, Number(r.n)]));

  const commentRows = await db
    .select({ pourId: schema.comments.pourId, n: sql<number>`count(*)` })
    .from(schema.comments)
    .where(
      and(
        inArray(schema.comments.pourId, pourIds),
        isNull(schema.comments.deletedAt),
        contributorVisibleSql(schema.comments.userId, viewerId),
      ),
    )
    .groupBy(schema.comments.pourId);
  const commentMap = new Map(commentRows.map((r) => [r.pourId, Number(r.n)]));

  const viewerCheersRows = await db
    .select({ pourId: schema.reactions.pourId })
    .from(schema.reactions)
    .where(
      and(
        inArray(schema.reactions.pourId, pourIds),
        eq(schema.reactions.userId, viewerId),
        eq(schema.reactions.kind, "cheers"),
      ),
    );
  const viewerCheeredSet = new Set(viewerCheersRows.map((r) => r.pourId));

  const viewerNoteRows = await db
    .select({ bottleId: schema.pours.bottleId, flavorTags: schema.tastingNotes.flavorTags })
    .from(schema.pours)
    .innerJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(and(eq(schema.pours.userId, viewerId), inArray(schema.pours.bottleId, bottleIds)));
  const viewerTagsByBottle = new Map<string, Record<string, number>>();
  for (const r of viewerNoteRows) {
    if (!r.flavorTags) continue;
    const acc = viewerTagsByBottle.get(r.bottleId) ?? {};
    for (const [leafId, intensity] of Object.entries(r.flavorTags)) {
      if (typeof intensity === "number") acc[leafId] = Math.max(acc[leafId] ?? 0, intensity);
    }
    viewerTagsByBottle.set(r.bottleId, acc);
  }

  const viewerRelRows = await db
    .select({ bottleId: schema.userBottles.bottleId, relationship: schema.userBottles.relationship })
    .from(schema.userBottles)
    .where(and(eq(schema.userBottles.userId, viewerId), inArray(schema.userBottles.bottleId, bottleIds)));
  const viewerRelByBottle = new Map(viewerRelRows.map((r) => [r.bottleId, r.relationship]));

  return rows.map((row) => {
    const relationship = viewerRelByBottle.get(row.bottleId) ?? null;
    return {
      pourId: row.pourId,
      bottleId: row.bottleId,
      bottleName: row.bottleName,
      author: {
        userId: row.authorId,
        handle: row.authorHandle,
        displayName: row.authorDisplayName,
        avatarUrl: row.authorAvatarUrl,
      },
      rating: row.rating,
      servingStyle: row.servingStyle,
      createdAt: row.createdAt,
      visibility: row.visibility,
      nose: row.nose,
      palate: row.palate,
      finish: row.finish,
      freeform: row.freeform,
      flavorTags: row.flavorTags,
      cheersCount: cheersMap.get(row.pourId) ?? 0,
      commentCount: commentMap.get(row.pourId) ?? 0,
      viewerCheered: viewerCheeredSet.has(row.pourId),
      viewerTags: viewerTagsByBottle.get(row.bottleId) ?? null,
      viewerTriedBottle: relationship === "own" || relationship === "tried",
      viewerBottleRelationship: relationship,
    };
  });
}

export interface FriendBottleNote {
  author: ProfileSummary;
  pourId: string;
  rating: number | null;
  createdAt: Date;
  flavorTags: Record<string, number> | null;
}

/** Same Dram source: one entry per followee (their latest note on this bottle), visibility+block enforced. */
export async function getFriendNotesForBottle(db: DB, viewerId: string, bottleId: string): Promise<FriendBottleNote[]> {
  const blocked = await getBlockedCounterparts(db, viewerId);
  const followeeIds = (await getAcceptedFolloweeIds(db, viewerId)).filter((id) => !blocked.has(id));
  if (followeeIds.length === 0) return [];

  const followsBackRows = await db
    .select({ followerId: schema.follows.followerId })
    .from(schema.follows)
    .where(
      and(
        inArray(schema.follows.followerId, followeeIds),
        eq(schema.follows.followeeId, viewerId),
        eq(schema.follows.state, "accepted"),
      ),
    );
  const friendIds = followsBackRows.map((r) => r.followerId);

  const visibilityCond =
    friendIds.length > 0
      ? or(
          inArray(schema.pours.visibility, ["followers", "public"]),
          and(eq(schema.pours.visibility, "friends"), inArray(schema.pours.userId, friendIds)),
        )
      : inArray(schema.pours.visibility, ["followers", "public"]);

  const rows = await db
    .select({
      authorId: schema.pours.userId,
      authorHandle: schema.userProfiles.handle,
      authorDisplayName: schema.userProfiles.displayName,
      authorAvatarUrl: schema.userProfiles.avatarUrl,
      pourId: schema.pours.id,
      rating: schema.pours.rating,
      createdAt: schema.pours.createdAt,
      flavorTags: schema.tastingNotes.flavorTags,
    })
    .from(schema.pours)
    .innerJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.pours.userId))
    // Inner join: Same Dram compares notes, so a newer note-less pour must not
    // shadow a friend's older tasted-and-described one.
    .innerJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(
      and(
        eq(schema.pours.bottleId, bottleId),
        inArray(schema.pours.userId, followeeIds),
        eq(schema.userProfiles.socialEnabled, true),
        visibilityCond,
      ),
    )
    .orderBy(desc(schema.pours.createdAt));

  const latestByAuthor = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByAuthor.has(row.authorId)) latestByAuthor.set(row.authorId, row);
  }

  return [...latestByAuthor.values()].map((row) => ({
    author: {
      userId: row.authorId,
      handle: row.authorHandle,
      displayName: row.authorDisplayName,
      avatarUrl: row.authorAvatarUrl,
    },
    pourId: row.pourId,
    rating: row.rating,
    createdAt: row.createdAt,
    flavorTags: row.flavorTags,
  }));
}

export interface PalateCard {
  wheelHeat: ReturnType<typeof palateWheelHeat> | null;
  signatureLeafIds: string[];
  regionsCovered: string[];
  stylesCovered: string[];
}

/**
 * regionsCovered/stylesCovered are bounded DISTINCT sets from the user's
 * own/tried bottles — never counts, per docs/SOCIAL.md §3.3.
 */
export async function getPalateCard(db: DB, userId: string): Promise<PalateCard> {
  const profile = await getUserPalate(db, userId);
  const wheelHeat = profile.sampleSize > 0 ? palateWheelHeat(profile) : null;
  const signatureLeafIds = Object.entries(profile.leaves)
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([leafId]) => leafId);

  const rows = await db
    .select({ region: schema.bottles.region, category: schema.bottles.category })
    .from(schema.userBottles)
    .innerJoin(schema.bottles, eq(schema.userBottles.bottleId, schema.bottles.id))
    .where(and(eq(schema.userBottles.userId, userId), inArray(schema.userBottles.relationship, ["own", "tried"])));

  const regionsCovered = [...new Set(rows.map((r) => r.region).filter((r): r is string => Boolean(r)))].sort();
  const stylesCovered = [...new Set(rows.map((r) => r.category))].sort();

  return { wheelHeat, signatureLeafIds, regionsCovered, stylesCovered };
}

export interface ProfileView {
  profile: SocialProfile;
  palate: PalateCard;
  recentNotes: SocialNote[];
  viewerState: { isSelf: boolean; followState: FollowState | null; followsYou: boolean; blocked: boolean };
}

const EMPTY_PALATE_CARD: PalateCard = { wheelHeat: null, signatureLeafIds: [], regionsCovered: [], stylesCovered: [] };

async function listRecentVisibleNotes(
  db: DB,
  viewerId: string | null,
  author: ProfileSummary & { socialEnabled: boolean },
  limit: number,
): Promise<SocialNote[]> {
  // Resolve the viewer's relationship once and filter visibility in SQL — a
  // bounded over-fetch would let a run of newer private pours hide older
  // public notes entirely ("No public notes yet" on a profile that has them).
  const isSelf = viewerId != null && viewerId === author.userId;
  let allowedTiers: PourVisibility[] | null = null; // null = owner, all tiers
  if (!isSelf) {
    if (viewerId == null) return [];
    const follower = await db.query.follows.findFirst({
      where: and(
        eq(schema.follows.followerId, viewerId),
        eq(schema.follows.followeeId, author.userId),
        eq(schema.follows.state, "accepted"),
      ),
    });
    const friend = follower ? await areFriends(db, viewerId, author.userId) : false;
    allowedTiers = ["public", ...(follower ? (["followers"] as const) : []), ...(friend ? (["friends"] as const) : [])];
  }

  const rows = await db
    .select({
      pourId: schema.pours.id,
      bottleId: schema.pours.bottleId,
      bottleName: schema.bottles.name,
      rating: schema.pours.rating,
      servingStyle: schema.pours.servingStyle,
      createdAt: schema.pours.createdAt,
      visibility: schema.pours.visibility,
      nose: schema.tastingNotes.nose,
      palate: schema.tastingNotes.palate,
      finish: schema.tastingNotes.finish,
      freeform: schema.tastingNotes.freeform,
      flavorTags: schema.tastingNotes.flavorTags,
      noteId: schema.tastingNotes.id,
    })
    .from(schema.pours)
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .leftJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(
      and(
        eq(schema.pours.userId, author.userId),
        // The palate card shows *notes* (§7.1) — a rating-only pour must not
        // consume one of the three slots and crowd out a real description.
        isNotNull(schema.tastingNotes.id),
        ...(allowedTiers ? [inArray(schema.pours.visibility, allowedTiers)] : []),
      ),
    )
    .orderBy(desc(schema.pours.createdAt))
    .limit(limit);

  const out: SocialNote[] = [];
  for (const row of rows) {
    out.push(await toSocialNote(db, viewerId, row, author));
  }
  return out;
}

/**
 * null when: no profile, socialEnabled=false (unless self), or blocked
 * either way (unless self). A private profile viewed by a non-follower
 * returns identity + viewerState with an empty palate/notes (so the page can
 * offer "request to follow"); a signed-out viewer always gets the
 * identity-only shape, even for a public profile.
 */
export async function getProfileView(db: DB, viewerId: string | null, handle: string): Promise<ProfileView | null> {
  const row = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.handle, normalizeHandle(handle)) });
  if (!row) return null;

  const isSelf = viewerId != null && viewerId === row.userId;
  if (!isSelf) {
    if (!row.socialEnabled) return null;
    if (viewerId != null && (await isBlockedEither(db, viewerId, row.userId))) return null;
  }

  let followState: FollowState | null = null;
  let followsYou = false;
  if (viewerId != null && !isSelf) {
    const forward = await db.query.follows.findFirst({
      where: and(eq(schema.follows.followerId, viewerId), eq(schema.follows.followeeId, row.userId)),
    });
    followState = forward ? forward.state : null;
    const back = await db.query.follows.findFirst({
      where: and(
        eq(schema.follows.followerId, row.userId),
        eq(schema.follows.followeeId, viewerId),
        eq(schema.follows.state, "accepted"),
      ),
    });
    followsYou = Boolean(back);
  }

  const profile = toSocialProfile(row);
  const viewerState = { isSelf, followState, followsYou, blocked: false };

  const canSeeContent = viewerId != null && (isSelf || row.isPublic || followState === "accepted");
  if (!canSeeContent) {
    return { profile, palate: EMPTY_PALATE_CARD, recentNotes: [], viewerState };
  }

  const [palate, recentNotes] = await Promise.all([
    getPalateCard(db, row.userId),
    listRecentVisibleNotes(db, viewerId, { ...toProfileSummary(row), socialEnabled: row.socialEnabled }, 3),
  ]);
  return { profile, palate, recentNotes, viewerState };
}

// ---------------------------------------------------------------------------
// Cheers
// ---------------------------------------------------------------------------

export async function cheerPour(db: DB, userId: string, pourId: string): Promise<{ cheersCount: number } | null> {
  if (!(await canViewPour(db, userId, pourId))) return null;
  await db
    .insert(schema.reactions)
    .values({ id: crypto.randomUUID(), pourId, userId, kind: "cheers" })
    .onConflictDoNothing();
  return { cheersCount: await countCheers(db, pourId, userId) };
}

export async function uncheerPour(db: DB, userId: string, pourId: string): Promise<{ cheersCount: number } | null> {
  if (!(await canViewPour(db, userId, pourId))) return null;
  await db
    .delete(schema.reactions)
    .where(and(eq(schema.reactions.pourId, pourId), eq(schema.reactions.userId, userId), eq(schema.reactions.kind, "cheers")));
  return { cheersCount: await countCheers(db, pourId, userId) };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export const COMMENT_MAX_LENGTH = 1000;
export const COMMENT_EDIT_WINDOW_MS = 15 * 60_000;

export interface CommentView {
  id: string;
  pourId: string;
  parentId: string | null;
  author: ProfileSummary | null;
  body: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deleted: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/**
 * null when the pour is not visible to the viewer; comments by users blocked
 * w.r.t. the viewer are dropped entirely (replies to a dropped comment keep
 * rendering under it — orphan-tolerant); ordered oldest-first.
 */
export async function listComments(db: DB, viewerId: string | null, pourId: string): Promise<CommentView[] | null> {
  if (!(await canViewPour(db, viewerId, pourId))) return null;

  const pour = await db.query.pours.findFirst({ where: eq(schema.pours.id, pourId) });
  if (!pour) return null;

  const rows = await db
    .select({
      id: schema.comments.id,
      pourId: schema.comments.pourId,
      parentId: schema.comments.parentId,
      userId: schema.comments.userId,
      body: schema.comments.body,
      createdAt: schema.comments.createdAt,
      editedAt: schema.comments.editedAt,
      deletedAt: schema.comments.deletedAt,
      authorHandle: schema.userProfiles.handle,
      authorDisplayName: schema.userProfiles.displayName,
      authorAvatarUrl: schema.userProfiles.avatarUrl,
      authorSocialEnabled: schema.userProfiles.socialEnabled,
    })
    .from(schema.comments)
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.comments.userId))
    .where(eq(schema.comments.pourId, pourId))
    .orderBy(asc(schema.comments.createdAt), asc(schema.comments.id));

  const blocked = viewerId ? await getBlockedCounterparts(db, viewerId) : new Set<string>();
  const now = Date.now();

  const out: CommentView[] = [];
  for (const row of rows) {
    if (blocked.has(row.userId)) continue;
    // A stepped-back author's comments vanish for everyone but themself (US-11).
    if (row.authorSocialEnabled === false && row.userId !== viewerId) continue;
    const deleted = row.deletedAt != null;
    const isAuthor = viewerId != null && viewerId === row.userId;
    const canEdit = isAuthor && !deleted && now - row.createdAt.getTime() <= COMMENT_EDIT_WINDOW_MS;
    const canDelete = !deleted && viewerId != null && (isAuthor || viewerId === pour.userId);
    out.push({
      id: row.id,
      pourId: row.pourId,
      parentId: row.parentId,
      author: deleted
        ? null
        : { userId: row.userId, handle: row.authorHandle ?? row.userId, displayName: row.authorDisplayName ?? "", avatarUrl: row.authorAvatarUrl },
      body: deleted ? null : row.body,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      deleted,
      canEdit,
      canDelete,
    });
  }
  return out;
}

/** null: pour not visible to `userId`, the pour owner has comments off, or parentId is missing/foreign/deleted. */
/** docs/SOCIAL.md §11: user-generated text is rate-limited on write. */
export const COMMENT_RATE_LIMIT_PER_HOUR = 30;

export class RateLimitedError extends Error {
  constructor() {
    super("Rate limited");
    this.name = "RateLimitedError";
  }
}

export async function addComment(
  db: DB,
  userId: string,
  pourId: string,
  body: string,
  parentId?: string,
): Promise<CommentView | null> {
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > COMMENT_MAX_LENGTH) return null;

  const ctx = await loadPourAuthContext(db, pourId);
  if (!ctx) return null;
  if (!(await canViewPourContext(db, userId, ctx))) return null;

  const ownerPrefs = await getSocialPrefs(db, ctx.authorId);
  if (!ownerPrefs.allowComments) return null;

  let effectiveParentId = parentId ?? null;
  if (effectiveParentId) {
    const parent = await db.query.comments.findFirst({
      where: and(eq(schema.comments.id, effectiveParentId), eq(schema.comments.pourId, pourId)),
    });
    if (!parent || parent.deletedAt != null) return null;
    // Threads are one level deep everywhere they render; a reply to a reply
    // re-parents onto the top-level comment instead of nesting unreachably.
    if (parent.parentId != null) effectiveParentId = parent.parentId;
  }

  // Durable rate limit off the comments table itself — soft-deleted rows
  // count, so delete-and-repost can't reset the window. The count and insert
  // run under a per-user advisory lock so concurrent requests can't all read
  // a below-limit count before any of them inserts.
  const [row] = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`comment-rl:${userId}`}))`);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await tx
      .select({ n: sql<number>`count(*)` })
      .from(schema.comments)
      .where(and(eq(schema.comments.userId, userId), sql`${schema.comments.createdAt} > ${hourAgo}`));
    if (Number(recent[0]?.n ?? 0) >= COMMENT_RATE_LIMIT_PER_HOUR) throw new RateLimitedError();
    return tx
      .insert(schema.comments)
      .values({ id: crypto.randomUUID(), pourId, userId, parentId: effectiveParentId, body: trimmed })
      .returning();
  });

  const author = await getOwnProfile(db, userId);
  return {
    id: row.id,
    pourId: row.pourId,
    parentId: row.parentId,
    author: author ? toProfileSummary(author) : { userId, handle: userId, displayName: "", avatarUrl: null },
    body: row.body,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deleted: false,
    canEdit: true,
    canDelete: true,
  };
}

export async function editComment(db: DB, userId: string, commentId: string, body: string): Promise<CommentView | null> {
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > COMMENT_MAX_LENGTH) return null;

  const existing = await db.query.comments.findFirst({ where: eq(schema.comments.id, commentId) });
  if (!existing || existing.deletedAt != null || existing.userId !== userId) return null;
  if (Date.now() - existing.createdAt.getTime() > COMMENT_EDIT_WINDOW_MS) return null;

  const now = new Date();
  const [row] = await db
    .update(schema.comments)
    .set({ body: trimmed, editedAt: now })
    .where(eq(schema.comments.id, commentId))
    .returning();

  const author = await getOwnProfile(db, userId);
  return {
    id: row.id,
    pourId: row.pourId,
    parentId: row.parentId,
    author: author ? toProfileSummary(author) : { userId, handle: userId, displayName: "", avatarUrl: null },
    body: row.body,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deleted: false,
    canEdit: Date.now() - row.createdAt.getTime() <= COMMENT_EDIT_WINDOW_MS,
    canDelete: true,
  };
}

/** Author, or the pour's owner, may soft-delete. Tombstones (blanks body/author on read) without removing the row. */
export async function softDeleteComment(db: DB, userId: string, commentId: string): Promise<boolean> {
  const existing = await db.query.comments.findFirst({ where: eq(schema.comments.id, commentId) });
  if (!existing || existing.deletedAt != null) return false;

  const isAuthor = existing.userId === userId;
  if (!isAuthor) {
    const pour = await db.query.pours.findFirst({ where: eq(schema.pours.id, existing.pourId) });
    if (pour?.userId !== userId) return false;
  }

  const updated = await db
    .update(schema.comments)
    .set({ deletedAt: new Date() })
    .where(eq(schema.comments.id, commentId))
    .returning({ id: schema.comments.id });
  return updated.length > 0;
}

export const REPORT_RATE_LIMIT_PER_HOUR = 20;

/**
 * Files a report. Returns false when the subject doesn't exist (fabricated
 * ids never reach the moderation queue); duplicate open reports by the same
 * reporter are absorbed idempotently; per-reporter writes are rate-limited
 * under an advisory lock (§11 — the queue must not be floodable).
 */
export async function createReport(
  db: DB,
  reporterId: string,
  input: { subjectType: ReportSubjectType; subjectId: string; reason: string },
): Promise<boolean> {
  let subjectExists = false;
  if (input.subjectType === "pour") {
    subjectExists = Boolean(
      await db.query.pours.findFirst({ columns: { id: true }, where: eq(schema.pours.id, input.subjectId) }),
    );
  } else if (input.subjectType === "comment") {
    subjectExists = Boolean(
      await db.query.comments.findFirst({ columns: { id: true }, where: eq(schema.comments.id, input.subjectId) }),
    );
  } else {
    subjectExists = Boolean(
      await db.query.userProfiles.findFirst({
        columns: { userId: true },
        where: eq(schema.userProfiles.userId, input.subjectId),
      }),
    );
  }
  if (!subjectExists) return false;

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`report-rl:${reporterId}`}))`);
    const existing = await tx.query.reports.findFirst({
      where: and(
        eq(schema.reports.reporterId, reporterId),
        eq(schema.reports.subjectType, input.subjectType),
        eq(schema.reports.subjectId, input.subjectId),
        eq(schema.reports.state, "open"),
      ),
    });
    if (existing) return;
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await tx
      .select({ n: sql<number>`count(*)` })
      .from(schema.reports)
      .where(and(eq(schema.reports.reporterId, reporterId), sql`${schema.reports.createdAt} > ${hourAgo}`));
    if (Number(recent[0]?.n ?? 0) >= REPORT_RATE_LIMIT_PER_HOUR) throw new RateLimitedError();
    await tx.insert(schema.reports).values({
      id: crypto.randomUUID(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      reporterId,
      reason: input.reason.trim(),
    });
  });
  return true;
}

export const commentCreateSchema = z.object({
  pourId: z.string().min(1),
  body: z.string().trim().min(1).max(COMMENT_MAX_LENGTH),
  parentId: z.string().min(1).optional(),
});

export const commentEditSchema = z.object({
  body: z.string().trim().min(1).max(COMMENT_MAX_LENGTH),
});

export const reportSchema = z.object({
  subjectType: z.enum(REPORT_SUBJECT_TYPES),
  subjectId: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
});

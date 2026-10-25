import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import type { ClubRole } from "@/db/schema";
import { notify } from "@/lib/notify";

/**
 * Clubs (docs/SOCIAL.md §7.8; design board C5): invite-only groups for the
 * people you actually taste with. No directory, no public page, no search —
 * a club is reached only by being in it or holding a live invite.
 *
 * Read rules, enforced here for every cross-member projection: a member you
 * blocked (or who blocked you), a suspended account and an account that
 * stepped back from social are left out of what you see — the same
 * predicate the feed uses. Money, volume and pour counts never appear; the
 * club shelf and passport count *distinct* bottles and places, which saturate.
 */

export const CLUB_NAME_MAX = 60;
export const CLUB_INVITE_DAYS = 7;
export const CLUB_MEMBER_LIMIT = 200;

export const clubCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(CLUB_NAME_MAX),
    description: z.string().trim().max(280).optional(),
  })
  .strict();

export const clubUpdateSchema = clubCreateSchema.partial().strict();

export class ClubProfileRequiredError extends Error {
  constructor() {
    super("profile_required");
  }
}

/** Visible to `viewerId`: present in social, not suspended, no block either way. */
export function memberVisibleSql(userCol: typeof schema.clubMembers.userId, viewerId: string) {
  return sql`(${userCol} = ${viewerId} or (
    exists (select 1 from user_profiles mp where mp.user_id = ${userCol} and mp.social_enabled = true and mp.suspended_at is null)
    and not exists (select 1 from blocks b where (b.blocker_id = ${viewerId} and b.blocked_id = ${userCol}) or (b.blocker_id = ${userCol} and b.blocked_id = ${viewerId}))
  ))`;
}

async function socialReady(db: DB, userId: string): Promise<boolean> {
  const row = await db.query.userProfiles.findFirst({
    columns: { socialEnabled: true, suspendedAt: true },
    where: eq(schema.userProfiles.userId, userId),
  });
  return !!row && row.socialEnabled && row.suspendedAt == null;
}

export async function getRole(db: DB, clubId: string, userId: string): Promise<ClubRole | null> {
  const row = await db.query.clubMembers.findFirst({
    columns: { role: true },
    where: and(eq(schema.clubMembers.clubId, clubId), eq(schema.clubMembers.userId, userId)),
  });
  return row?.role ?? null;
}

const isAdmin = (role: ClubRole | null) => role === "owner" || role === "admin";

export async function createClub(
  db: DB,
  userId: string,
  input: z.infer<typeof clubCreateSchema>,
): Promise<schema.Club> {
  if (!(await socialReady(db, userId))) throw new ClubProfileRequiredError();
  return db.transaction(async (tx) => {
    const [club] = await tx
      .insert(schema.clubs)
      .values({ id: crypto.randomUUID(), name: input.name, description: input.description || null, createdBy: userId })
      .returning();
    await tx.insert(schema.clubMembers).values({ clubId: club.id, userId, role: "owner" });
    return club;
  });
}

export async function updateClub(db: DB, userId: string, clubId: string, patch: z.infer<typeof clubUpdateSchema>) {
  if (!isAdmin(await getRole(db, clubId, userId))) return null;
  const [row] = await db
    .update(schema.clubs)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description || null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.clubs.id, clubId))
    .returning();
  return row ?? null;
}

export async function deleteClub(db: DB, userId: string, clubId: string): Promise<boolean> {
  if ((await getRole(db, clubId, userId)) !== "owner") return false;
  await db.delete(schema.clubs).where(eq(schema.clubs.id, clubId));
  return true;
}

export interface MyClub {
  id: string;
  name: string;
  role: ClubRole;
  memberCount: number;
}

export async function listMyClubs(db: DB, userId: string): Promise<MyClub[]> {
  const rows = await db
    .select({
      id: schema.clubs.id,
      name: schema.clubs.name,
      role: schema.clubMembers.role,
      memberCount: sql<number>`(select count(*) from club_members cm where cm.club_id = ${schema.clubs.id})`,
    })
    .from(schema.clubMembers)
    .innerJoin(schema.clubs, eq(schema.clubs.id, schema.clubMembers.clubId))
    .where(eq(schema.clubMembers.userId, userId))
    .orderBy(asc(schema.clubs.name));
  return rows.map((r) => ({ ...r, memberCount: Number(r.memberCount) }));
}

/**
 * A club always has an owner while it has members. Ownership moves to the
 * longest-standing admin, else the longest-standing member, whenever the
 * owner row disappears (they left, or deleted their account and the row
 * cascaded). A club with nobody left is deleted.
 */
export async function ensureOwner(db: DB, clubId: string): Promise<void> {
  const members = await db
    .select({ userId: schema.clubMembers.userId, role: schema.clubMembers.role })
    .from(schema.clubMembers)
    .where(eq(schema.clubMembers.clubId, clubId))
    .orderBy(asc(schema.clubMembers.joinedAt));
  if (members.length === 0) {
    await db.delete(schema.clubs).where(eq(schema.clubs.id, clubId));
    return;
  }
  if (members.some((m) => m.role === "owner")) return;
  const heir = members.find((m) => m.role === "admin") ?? members[0];
  await db
    .update(schema.clubMembers)
    .set({ role: "owner" })
    .where(and(eq(schema.clubMembers.clubId, clubId), eq(schema.clubMembers.userId, heir.userId)));
}

/** Nightly: clubs left without members, and owner repair for the rest. */
export async function sweepClubs(db: DB): Promise<void> {
  const ownerless = await db
    .select({ id: schema.clubs.id })
    .from(schema.clubs)
    .where(sql`not exists (select 1 from club_members cm where cm.club_id = ${schema.clubs.id} and cm.role = 'owner')`);
  for (const { id } of ownerless) await ensureOwner(db, id);
  await db.delete(schema.clubInvites).where(sql`${schema.clubInvites.expiresAt} < now() - interval '30 days'`);
}

const INVITE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function newCode(length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  return out;
}

export async function createInvite(db: DB, userId: string, clubId: string, now = new Date()) {
  if (!isAdmin(await getRole(db, clubId, userId))) return null;
  const [row] = await db
    .insert(schema.clubInvites)
    .values({
      code: newCode(),
      clubId,
      createdBy: userId,
      expiresAt: new Date(now.getTime() + CLUB_INVITE_DAYS * 86_400_000),
    })
    .returning();
  return row;
}

export async function revokeInvite(db: DB, userId: string, code: string): Promise<boolean> {
  const invite = await db.query.clubInvites.findFirst({ where: eq(schema.clubInvites.code, code) });
  if (!invite || !isAdmin(await getRole(db, invite.clubId, userId))) return false;
  await db.update(schema.clubInvites).set({ revokedAt: new Date() }).where(eq(schema.clubInvites.code, code));
  return true;
}

export interface InvitePreview {
  clubId: string;
  clubName: string;
  memberCount: number;
  alreadyMember: boolean;
}

async function liveInvite(db: DB, code: string, now: Date) {
  if (!/^[a-z0-9]{6,16}$/.test(code)) return null;
  const invite = await db.query.clubInvites.findFirst({
    where: and(eq(schema.clubInvites.code, code), isNull(schema.clubInvites.revokedAt), gt(schema.clubInvites.expiresAt, now)),
  });
  return invite ?? null;
}

export async function previewInvite(db: DB, userId: string, code: string, now = new Date()): Promise<InvitePreview | null> {
  const invite = await liveInvite(db, code, now);
  if (!invite) return null;
  const club = await db.query.clubs.findFirst({ where: eq(schema.clubs.id, invite.clubId) });
  if (!club) return null;
  const [n] = await db.select({ n: count() }).from(schema.clubMembers).where(eq(schema.clubMembers.clubId, club.id));
  return { clubId: club.id, clubName: club.name, memberCount: Number(n?.n ?? 0), alreadyMember: (await getRole(db, club.id, userId)) != null };
}

export type JoinResult = { clubId: string } | { error: "invalid" | "profile_required" | "full" };

export async function joinByCode(db: DB, userId: string, code: string, now = new Date()): Promise<JoinResult> {
  const invite = await liveInvite(db, code, now);
  if (!invite) return { error: "invalid" };
  if (!(await socialReady(db, userId))) return { error: "profile_required" };
  if ((await getRole(db, invite.clubId, userId)) != null) return { clubId: invite.clubId };
  const [n] = await db.select({ n: count() }).from(schema.clubMembers).where(eq(schema.clubMembers.clubId, invite.clubId));
  if (Number(n?.n ?? 0) >= CLUB_MEMBER_LIMIT) return { error: "full" };
  const inserted = await db
    .insert(schema.clubMembers)
    .values({ clubId: invite.clubId, userId, role: "member" })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    await db
      .update(schema.clubInvites)
      .set({ uses: sql`${schema.clubInvites.uses} + 1` })
      .where(eq(schema.clubInvites.code, code));
    const club = await db.query.clubs.findFirst({ columns: { name: true }, where: eq(schema.clubs.id, invite.clubId) });
    const admins = await db
      .select({ userId: schema.clubMembers.userId })
      .from(schema.clubMembers)
      .where(and(eq(schema.clubMembers.clubId, invite.clubId), inArray(schema.clubMembers.role, ["owner", "admin"])));
    for (const a of admins) {
      await notify(db, {
        recipientId: a.userId,
        actorId: userId,
        category: "club",
        subjectId: invite.clubId,
        data: { event: "joined", clubName: club?.name ?? "" },
        dedupeKey: `club_joined:${invite.clubId}:${userId}`,
      });
    }
  }
  return { clubId: invite.clubId };
}

/** Leave, or (admin) remove someone. The owner can only be removed by leaving. */
export async function removeMember(db: DB, actorId: string, clubId: string, targetId: string): Promise<boolean> {
  const actorRole = await getRole(db, clubId, actorId);
  const targetRole = await getRole(db, clubId, targetId);
  if (!actorRole || !targetRole) return false;
  if (actorId !== targetId) {
    if (!isAdmin(actorRole) || targetRole === "owner") return false;
    if (actorRole === "admin" && targetRole === "admin") return false;
  }
  await db
    .delete(schema.clubMembers)
    .where(and(eq(schema.clubMembers.clubId, clubId), eq(schema.clubMembers.userId, targetId)));
  await ensureOwner(db, clubId);
  return true;
}

/** Owner only: promote/demote, or hand ownership over (the old owner becomes an admin). */
export async function setRole(db: DB, ownerId: string, clubId: string, targetId: string, role: ClubRole): Promise<boolean> {
  if ((await getRole(db, clubId, ownerId)) !== "owner" || ownerId === targetId) return false;
  if ((await getRole(db, clubId, targetId)) == null) return false;
  await db.transaction(async (tx) => {
    if (role === "owner") {
      await tx
        .update(schema.clubMembers)
        .set({ role: "admin" })
        .where(and(eq(schema.clubMembers.clubId, clubId), eq(schema.clubMembers.userId, ownerId)));
    }
    await tx
      .update(schema.clubMembers)
      .set({ role })
      .where(and(eq(schema.clubMembers.clubId, clubId), eq(schema.clubMembers.userId, targetId)));
  });
  return true;
}

export const roleSchema = z.object({ role: z.enum(["owner", "admin", "member"]) }).strict();

export interface ClubMemberView {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  role: ClubRole;
}

export interface ClubShelfBottle {
  id: string;
  name: string;
  country: string | null;
  region: string | null;
}

export interface ClubView {
  id: string;
  name: string;
  description: string | null;
  viewerRole: ClubRole;
  members: ClubMemberView[];
  flights: Array<{ id: string; title: string; state: schema.FlightState; joinCode: string; scheduledAt: Date | null; createdAt: Date }>;
  shelf: ClubShelfBottle[];
  passport: { countries: number; regions: number };
  invites: Array<{ code: string; expiresAt: Date; uses: number }>;
}

/**
 * The club shelf: distinct bottles "tasted by the club" — what was revealed
 * at the club's tasting nights, plus members' notes they already share with
 * followers or publicly (never a friends-only or private pour, whose audience
 * the club is not). Distinct, so it saturates; no counts per person.
 */
export async function clubShelf(db: DB, viewerId: string, clubId: string): Promise<ClubShelfBottle[]> {
  const fromFlights = db
    .select({ bottleId: schema.flightBottles.bottleId })
    .from(schema.flightBottles)
    .innerJoin(schema.flights, eq(schema.flights.id, schema.flightBottles.flightId))
    .where(and(eq(schema.flights.clubId, clubId), ne(schema.flights.state, "open")));
  const fromPours = db
    .select({ bottleId: schema.pours.bottleId })
    .from(schema.pours)
    .innerJoin(schema.clubMembers, eq(schema.clubMembers.userId, schema.pours.userId))
    .where(
      and(
        eq(schema.clubMembers.clubId, clubId),
        inArray(schema.pours.visibility, ["followers", "public"]),
        memberVisibleSql(schema.clubMembers.userId, viewerId),
      ),
    );
  const ids = [...new Set([...(await fromFlights).map((r) => r.bottleId), ...(await fromPours).map((r) => r.bottleId)])];
  if (ids.length === 0) return [];
  return db
    .select({ id: schema.bottles.id, name: schema.bottles.name, country: schema.bottles.country, region: schema.bottles.region })
    .from(schema.bottles)
    .where(inArray(schema.bottles.id, ids))
    .orderBy(asc(schema.bottles.name));
}

export async function getClubView(db: DB, viewerId: string, clubId: string): Promise<ClubView | null> {
  const viewerRole = await getRole(db, clubId, viewerId);
  if (!viewerRole) return null;
  const club = await db.query.clubs.findFirst({ where: eq(schema.clubs.id, clubId) });
  if (!club) return null;
  const members = await db
    .select({
      userId: schema.clubMembers.userId,
      handle: schema.userProfiles.handle,
      displayName: schema.userProfiles.displayName,
      avatarUrl: schema.userProfiles.avatarUrl,
      role: schema.clubMembers.role,
    })
    .from(schema.clubMembers)
    .innerJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.clubMembers.userId))
    .where(and(eq(schema.clubMembers.clubId, clubId), memberVisibleSql(schema.clubMembers.userId, viewerId)))
    .orderBy(sql`case ${schema.clubMembers.role} when 'owner' then 0 when 'admin' then 1 else 2 end`, asc(schema.userProfiles.handle));
  const flights = await db
    .select({
      id: schema.flights.id,
      title: schema.flights.title,
      state: schema.flights.state,
      joinCode: schema.flights.joinCode,
      scheduledAt: schema.flights.scheduledAt,
      createdAt: schema.flights.createdAt,
    })
    .from(schema.flights)
    .where(and(eq(schema.flights.clubId, clubId), sql`not exists (select 1 from blocks b where (b.blocker_id = ${viewerId} and b.blocked_id = ${schema.flights.hostId}) or (b.blocker_id = ${schema.flights.hostId} and b.blocked_id = ${viewerId}))`))
    .orderBy(desc(schema.flights.createdAt))
    .limit(20);
  const shelf = await clubShelf(db, viewerId, clubId);
  const invites = isAdmin(viewerRole)
    ? await db
        .select({ code: schema.clubInvites.code, expiresAt: schema.clubInvites.expiresAt, uses: schema.clubInvites.uses })
        .from(schema.clubInvites)
        .where(and(eq(schema.clubInvites.clubId, clubId), isNull(schema.clubInvites.revokedAt), gt(schema.clubInvites.expiresAt, new Date())))
        .orderBy(desc(schema.clubInvites.createdAt))
    : [];
  return {
    id: club.id,
    name: club.name,
    description: club.description,
    viewerRole,
    members: members.map((m) => ({ ...m, displayName: m.displayName ?? "" })),
    flights,
    shelf,
    passport: {
      countries: new Set(shelf.map((b) => b.country).filter(Boolean)).size,
      regions: new Set(shelf.map((b) => b.region).filter(Boolean)).size,
    },
    invites,
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(header: string[], rows: unknown[][]): string {
  return `\uFEFF${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** The club's shared data as CSV, for any member (owner: "import/export everywhere"). */
export async function clubExportCsv(db: DB, viewerId: string, clubId: string): Promise<string | null> {
  const view = await getClubView(db, viewerId, clubId);
  if (!view) return null;
  const rows: unknown[][] = [];
  for (const m of view.members) rows.push(["member", `@${m.handle}`, m.role, ""]);
  for (const f of view.flights) rows.push(["tasting_night", f.title, f.state, f.scheduledAt ?? f.createdAt]);
  for (const b of view.shelf) rows.push(["shelf", b.name, b.country ?? "", b.region ?? ""]);
  return toCsv(["kind", "name", "detail", "extra"], rows);
}

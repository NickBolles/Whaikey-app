import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { ageOn, minimumAgeFor } from "@/lib/age-gate";
import { canViewBottle } from "@/lib/catalog-visibility";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";
import { getRole, newCode, toCsv } from "@/lib/clubs";
import { GUEST_HOURS, guestJoinSchema, hashGuestToken } from "@/lib/flights";
import { notify } from "@/lib/notify";
import { acceptedFollowSql, isSuspended } from "@/lib/social";

/**
 * Outings — a group distillery visit (docs/SOCIAL.md §7.15, D22).
 *
 * A host plans the trip (distillery, day), friends join by link or QR — with
 * an account, or as a 24 h guest after the same 21+ birth-date check a
 * tasting night uses (D20) — and during the visit everyone logs what they
 * tasted against the outing, including distillery-only cask samples that are
 * not in any catalog. The outing has a shared feed of those tastings and
 * short notes, and when the host ends it, a recap: the bottles the group met,
 * the favourite by consensus and the flavour spread.
 *
 * What it deliberately does not have (§3.1): no amounts, no per-person
 * counts, no "who's tasting now", no reminders to log, no device location.
 * The read path mirrors tasting nights (§13): the host must be reachable,
 * blocked pairs never see each other, suspended or stepped-back accounts
 * vanish from the feed, and the host can hide anything from it.
 */

export const OUTING_GUEST_HOURS = GUEST_HOURS;
/**
 * Per-person caps on one outing (§11: cross-user writes are rate-limited).
 * Generous for a day at a distillery — a flight of samples, the gift shop,
 * notes — and a stop for a script or a stuck button. Never shown to anyone.
 */
export const OUTING_ITEM_CAP = 60;
export const outingGuestCookieName = (joinCode: string) => `whaikey_outing_${joinCode}`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (v: string) => DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

export const outingCreateSchema = z
  .object({
    title: z.string().trim().min(2).max(80),
    distilleryName: z.string().trim().min(2).max(80),
    location: z.string().trim().max(120).optional(),
    visitOn: z.string().refine(isRealDay, "a calendar day, YYYY-MM-DD"),
    clubId: z.string().min(1).max(64).optional(),
    rideReminder: z.boolean().default(true),
  })
  .strict();

const flavorTagsSchema = z
  .record(z.string().max(40), z.number().int().min(1).max(3))
  .refine((v) => Object.keys(v).every((k) => leafLabel(k) != null), "unknown flavor tag")
  .refine((v) => Object.keys(v).length <= 8, "at most 8 flavor tags");

export const tastingSchema = z
  .object({
    /** A catalog bottle (or your own submission) … */
    bottleId: z.string().min(1).max(128).optional(),
    /** … or just a name: "Cask 1142, 9 yr wheated, barrel-proof sample". */
    label: z.string().trim().min(2).max(120).optional(),
    rating: z.number().min(0.5).max(5).multipleOf(0.5).nullable().optional(),
    flavorTags: flavorTagsSchema.nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => !!v.bottleId || !!v.label, "a bottle or a name");

export const tastingUpdateSchema = z
  .object({
    rating: z.number().min(0.5).max(5).multipleOf(0.5).nullable().optional(),
    flavorTags: flavorTagsSchema.nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const outingBottleSchema = z
  .object({
    bottleId: z.string().min(1).max(128).optional(),
    label: z.string().trim().min(2).max(120).optional(),
  })
  .strict()
  .refine((v) => !!v.bottleId || !!v.label, "a bottle or a name");

export const outingNoteSchema = z.object({ body: z.string().trim().min(1).max(280) }).strict();

export { guestJoinSchema };

export class OutingProfileRequiredError extends Error {
  constructor() {
    super("profile_required");
  }
}
export class OutingClubError extends Error {
  constructor() {
    super("not_a_member");
  }
}

/** Reachable = has a profile, social on, not suspended. */
async function reachable(db: DB, userId: string): Promise<boolean> {
  const p = await db.query.userProfiles.findFirst({
    columns: { socialEnabled: true, suspendedAt: true },
    where: eq(schema.userProfiles.userId, userId),
  });
  return !!p && p.socialEnabled && p.suspendedAt == null;
}

async function blockedEither(db: DB, a: string, b: string) {
  const rows = await db
    .select({ id: schema.blocks.id })
    .from(schema.blocks)
    .where(sql`(${schema.blocks.blockerId} = ${a} and ${schema.blocks.blockedId} = ${b}) or (${schema.blocks.blockerId} = ${b} and ${schema.blocks.blockedId} = ${a})`)
    .limit(1);
  return rows.length > 0;
}

/** A catalog distillery whose name matches what the host typed, case- and punctuation-insensitively. */
async function matchDistillery(db: DB, name: string): Promise<string | null> {
  const key = name.toLowerCase().replace(/['’.-]/g, "").trim();
  const rows = await db
    .select({ id: schema.distilleries.id })
    .from(schema.distilleries)
    .where(sql`${schema.catalogSearchKey(schema.distilleries.name)} = ${key}`)
    .limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

export async function createOuting(db: DB, hostId: string, input: z.infer<typeof outingCreateSchema>) {
  if (!(await reachable(db, hostId))) throw new OutingProfileRequiredError();
  if (input.clubId && (await getRole(db, input.clubId, hostId)) == null) throw new OutingClubError();
  const distilleryId = await matchDistillery(db, input.distilleryName);
  const outing = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.outings)
      .values({
        id: crypto.randomUUID(),
        hostId,
        clubId: input.clubId ?? null,
        title: input.title,
        distilleryName: input.distilleryName,
        distilleryId,
        location: input.location || null,
        visitOn: input.visitOn,
        rideReminder: input.rideReminder,
        joinCode: newCode(10),
      })
      .returning();
    await tx.insert(schema.outingParticipants).values({ id: crypto.randomUUID(), outingId: row.id, userId: hostId });
    return row;
  });
  if (outing.clubId) {
    const members = await db.select({ userId: schema.clubMembers.userId }).from(schema.clubMembers).where(eq(schema.clubMembers.clubId, outing.clubId));
    for (const m of members) await inviteNotice(db, outing, hostId, m.userId);
  }
  return outing;
}

function inviteNotice(db: DB, outing: schema.Outing, hostId: string, recipientId: string) {
  return notify(db, {
    recipientId,
    actorId: hostId,
    category: "outing",
    subjectId: outing.joinCode,
    data: { event: "invite", outingTitle: outing.title, distillery: outing.distilleryName },
    dedupeKey: `outing_invite:${outing.id}:${recipientId}`,
  });
}

export async function outingByCode(db: DB, code: string) {
  if (!/^[a-z0-9]{6,16}$/.test(code)) return null;
  return (await db.query.outings.findFirst({ where: eq(schema.outings.joinCode, code) })) ?? null;
}

/** The host-side read-path check (§13), identical to a tasting night's. */
export async function outingVisibleTo(db: DB, outing: schema.Outing, viewerUserId: string | null): Promise<boolean> {
  // Viewer side first: a suspended account reads nobody else's data — and an
  // outing, even one it hosts, is mostly other people's (social.ts suspendedViewer).
  if (viewerUserId && (await isSuspended(db, viewerUserId))) return false;
  if (viewerUserId === outing.hostId) return true;
  if (!(await reachable(db, outing.hostId))) return false;
  if (viewerUserId && (await blockedEither(db, outing.hostId, viewerUserId))) return false;
  return true;
}

export async function visibleOutingByCode(db: DB, code: string, viewerUserId: string | null) {
  const outing = await outingByCode(db, code);
  if (!outing || !(await outingVisibleTo(db, outing, viewerUserId))) return null;
  return outing;
}

export interface OutingSeat {
  participantId: string;
  userId: string | null;
  guest: boolean;
}

export async function findOutingSeat(
  db: DB,
  outingId: string,
  who: { userId?: string | null; guestToken?: string | null },
  now = new Date(),
): Promise<OutingSeat | null> {
  if (who.userId) {
    const row = await db.query.outingParticipants.findFirst({
      where: and(eq(schema.outingParticipants.outingId, outingId), eq(schema.outingParticipants.userId, who.userId)),
    });
    if (row) return { participantId: row.id, userId: row.userId, guest: false };
  }
  if (who.guestToken) {
    const row = await db.query.outingParticipants.findFirst({
      where: and(
        eq(schema.outingParticipants.outingId, outingId),
        eq(schema.outingParticipants.guestTokenHash, hashGuestToken(who.guestToken)),
        isNull(schema.outingParticipants.userId),
      ),
    });
    if (row && row.expiresAt && row.expiresAt > now) return { participantId: row.id, userId: null, guest: true };
  }
  return null;
}

export type OutingJoinOutcome = { participantId: string } | { error: "closed" | "blocked" | "underage" | "profile_required" };

export async function joinOutingAsUser(db: DB, outingId: string, userId: string): Promise<OutingJoinOutcome> {
  const outing = await db.query.outings.findFirst({ where: eq(schema.outings.id, outingId) });
  if (!outing || outing.state !== "open") return { error: "closed" };
  if (userId !== outing.hostId && !(await reachable(db, userId))) return { error: "profile_required" };
  if (await blockedEither(db, outing.hostId, userId)) return { error: "blocked" };
  const existing = await findOutingSeat(db, outingId, { userId });
  if (existing) return { participantId: existing.participantId };
  const [row] = await db
    .insert(schema.outingParticipants)
    .values({ id: crypto.randomUUID(), outingId, userId })
    .onConflictDoNothing()
    .returning();
  if (row) return { participantId: row.id };
  const raced = await findOutingSeat(db, outingId, { userId });
  return raced ? { participantId: raced.participantId } : { error: "closed" };
}

/** A 24 h guest seat after the market's minimum-age check; the birth date is checked, never stored. */
export async function joinOutingAsGuest(
  db: DB,
  outingId: string,
  input: z.infer<typeof guestJoinSchema>,
  now = new Date(),
): Promise<OutingJoinOutcome & { token?: string; expiresAt?: Date }> {
  const outing = await db.query.outings.findFirst({ where: eq(schema.outings.id, outingId) });
  if (!outing || outing.state !== "open") return { error: "closed" };
  if (ageOn(input.birthDate, now) < minimumAgeFor(input.market)) return { error: "underage" };
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + OUTING_GUEST_HOURS * 3600_000);
  const [row] = await db
    .insert(schema.outingParticipants)
    .values({ id: crypto.randomUUID(), outingId, guestTokenHash: hashGuestToken(token), guestName: input.guestName, joinedAt: now, expiresAt })
    .returning();
  return { participantId: row.id, token, expiresAt };
}

/** A guest who created an account keeps what they logged: the seat (or its rows) moves to the account. */
export async function claimOutingGuestSeat(db: DB, outingId: string, guestToken: string, userId: string, now = new Date()) {
  const guest = await findOutingSeat(db, outingId, { guestToken }, now);
  if (!guest) return false;
  const mine = await findOutingSeat(db, outingId, { userId }, now);
  if (!mine) {
    await db
      .update(schema.outingParticipants)
      .set({ userId, guestTokenHash: null, expiresAt: null, guestName: null })
      .where(eq(schema.outingParticipants.id, guest.participantId));
    return true;
  }
  await db.update(schema.outingTastings).set({ participantId: mine.participantId }).where(eq(schema.outingTastings.participantId, guest.participantId));
  await db.update(schema.outingNotes).set({ participantId: mine.participantId }).where(eq(schema.outingNotes.participantId, guest.participantId));
  // Bottles the guest put on the shared list move with them (the FK would cascade-delete them).
  await db.update(schema.outingBottles).set({ participantId: mine.participantId }).where(eq(schema.outingBottles.participantId, guest.participantId));
  await db.delete(schema.outingParticipants).where(eq(schema.outingParticipants.id, guest.participantId));
  return true;
}

export type AddTastingResult = { id: string } | { error: "not_open" | "bottle_not_found" | "too_many" };

async function atCap(db: DB, table: typeof schema.outingTastings | typeof schema.outingNotes | typeof schema.outingBottles, participantId: string) {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(table).where(eq(table.participantId, participantId));
  return Number(row?.n ?? 0) >= OUTING_ITEM_CAP;
}

export async function addTasting(
  db: DB,
  outing: schema.Outing,
  seat: OutingSeat,
  input: z.infer<typeof tastingSchema>,
): Promise<AddTastingResult> {
  if (outing.state !== "open") return { error: "not_open" };
  if (await atCap(db, schema.outingTastings, seat.participantId)) return { error: "too_many" };
  let label = input.label ?? "";
  let bottleId: string | null = null;
  if (input.bottleId) {
    const bottle = await db.query.bottles.findFirst({ where: eq(schema.bottles.id, input.bottleId) });
    // Same rule as a pour: the catalog, or your own not-yet-reviewed submission.
    if (!bottle || !canViewBottle(bottle, seat.userId ?? undefined)) return { error: "bottle_not_found" };
    // A taster's own pending submission is shown to the trip by the name they
    // gave it — their words, exactly as if they had typed it as a label — but
    // never as a link or a catalog entry: the feed checks `canViewBottle` per
    // viewer, so for everyone else it is plain text (PLAN-A1 holds).
    bottleId = bottle.id;
    label = bottle.name;
  }
  const [row] = await db
    .insert(schema.outingTastings)
    .values({
      id: crypto.randomUUID(),
      outingId: outing.id,
      participantId: seat.participantId,
      bottleId,
      label,
      rating: input.rating ?? null,
      flavorTags: input.flavorTags && Object.keys(input.flavorTags).length ? input.flavorTags : null,
      note: input.note || null,
    })
    .returning({ id: schema.outingTastings.id });
  // A tasting puts its bottle on the group's list too, so it fills in for everyone.
  await addOutingBottle(db, outing, seat, bottleId ? { bottleId } : { label }).catch(() => null);
  return { id: row.id };
}

/** Edit your own tasting while the outing is open. */
export async function updateTasting(db: DB, outing: schema.Outing, seat: OutingSeat, tastingId: string, input: z.infer<typeof tastingUpdateSchema>) {
  if (outing.state !== "open") return false;
  const patch: Partial<typeof schema.outingTastings.$inferInsert> = { updatedAt: new Date() };
  if (input.rating !== undefined) patch.rating = input.rating;
  if (input.flavorTags !== undefined) patch.flavorTags = input.flavorTags && Object.keys(input.flavorTags).length ? input.flavorTags : null;
  if (input.note !== undefined) patch.note = input.note || null;
  const rows = await db
    .update(schema.outingTastings)
    .set(patch)
    .where(and(eq(schema.outingTastings.id, tastingId), eq(schema.outingTastings.outingId, outing.id), eq(schema.outingTastings.participantId, seat.participantId)))
    .returning({ id: schema.outingTastings.id });
  return rows.length > 0;
}

/** Remove your own tasting or note — any time, open or ended. */
export async function deleteOwnItem(db: DB, outing: schema.Outing, seat: OutingSeat, kind: "tasting" | "note", id: string) {
  const table = kind === "tasting" ? schema.outingTastings : schema.outingNotes;
  const rows = await db
    .delete(table)
    .where(and(eq(table.id, id), eq(table.outingId, outing.id), eq(table.participantId, seat.participantId)))
    .returning({ id: table.id });
  return rows.length > 0;
}

/** One entry per bottle: a catalog bottle by id, anything else by its normalised name. */
export const outingBottleKey = (bottleId: string | null | undefined, label: string) => (bottleId ? `b:${bottleId}` : `l:${normLabel(label)}`);

export type AddOutingBottleResult = { id: string; existed: boolean } | { error: "not_open" | "bottle_not_found" | "too_many" };

/**
 * Put a bottle on the outing's shared list. Idempotent per bottle: adding one
 * that's already there returns the existing entry (`existed`), so two people
 * scanning the same bottle — or an offline retry — make one entry.
 */
export async function addOutingBottle(
  db: DB,
  outing: schema.Outing,
  seat: OutingSeat,
  input: z.infer<typeof outingBottleSchema>,
): Promise<AddOutingBottleResult> {
  if (outing.state !== "open") return { error: "not_open" };
  let label = input.label ?? "";
  let bottleId: string | null = null;
  if (input.bottleId) {
    const bottle = await db.query.bottles.findFirst({ where: eq(schema.bottles.id, input.bottleId) });
    if (!bottle || !canViewBottle(bottle, seat.userId ?? undefined)) return { error: "bottle_not_found" };
    bottleId = bottle.id;
    label = bottle.name;
  }
  const dedupeKey = outingBottleKey(bottleId, label);
  const existing = await db.query.outingBottles.findFirst({
    columns: { id: true },
    where: and(eq(schema.outingBottles.outingId, outing.id), eq(schema.outingBottles.dedupeKey, dedupeKey)),
  });
  if (existing) return { id: existing.id, existed: true };
  if (await atCap(db, schema.outingBottles, seat.participantId)) return { error: "too_many" };
  const [row] = await db
    .insert(schema.outingBottles)
    .values({ id: crypto.randomUUID(), outingId: outing.id, participantId: seat.participantId, bottleId, label, dedupeKey })
    .onConflictDoNothing()
    .returning({ id: schema.outingBottles.id });
  if (row) return { id: row.id, existed: false };
  const raced = await db.query.outingBottles.findFirst({
    columns: { id: true },
    where: and(eq(schema.outingBottles.outingId, outing.id), eq(schema.outingBottles.dedupeKey, dedupeKey)),
  });
  return raced ? { id: raced.id, existed: true } : { error: "not_open" };
}

/** Remove a bottle you added (or, host, anyone's) from the list. Tastings stay. */
export async function removeOutingBottle(db: DB, outing: schema.Outing, seat: OutingSeat | null, isHost: boolean, id: string) {
  const own = seat ? eq(schema.outingBottles.participantId, seat.participantId) : sql`false`;
  const rows = isHost
    ? await db
        .update(schema.outingBottles)
        .set({ hiddenAt: new Date() })
        .where(and(eq(schema.outingBottles.id, id), eq(schema.outingBottles.outingId, outing.id)))
        .returning({ id: schema.outingBottles.id })
    : await db
        .delete(schema.outingBottles)
        .where(and(eq(schema.outingBottles.id, id), eq(schema.outingBottles.outingId, outing.id), own))
        .returning({ id: schema.outingBottles.id });
  return rows.length > 0;
}

export async function addOutingNote(db: DB, outing: schema.Outing, seat: OutingSeat, body: string) {
  if (outing.state !== "open") return null;
  if (await atCap(db, schema.outingNotes, seat.participantId)) return null;
  const [row] = await db
    .insert(schema.outingNotes)
    .values({ id: crypto.randomUUID(), outingId: outing.id, participantId: seat.participantId, body })
    .returning({ id: schema.outingNotes.id });
  return row;
}

/** The host hides a tasting or note from the outing feed (moderation hook). */
export async function hideOutingItem(db: DB, hostId: string, outing: schema.Outing, kind: "tasting" | "note", id: string) {
  if (outing.hostId !== hostId) return false;
  const table = kind === "tasting" ? schema.outingTastings : schema.outingNotes;
  const rows = await db
    .update(table)
    .set({ hiddenAt: new Date() })
    .where(and(eq(table.id, id), eq(table.outingId, outing.id)))
    .returning({ id: table.id });
  return rows.length > 0;
}

export async function endOuting(db: DB, hostId: string, outingId: string) {
  const [row] = await db
    .update(schema.outings)
    .set({ state: "ended", endedAt: new Date() })
    .where(and(eq(schema.outings.id, outingId), eq(schema.outings.hostId, hostId), eq(schema.outings.state, "open")))
    .returning();
  if (!row) return null;
  const seated = await db
    .select({ userId: schema.outingParticipants.userId })
    .from(schema.outingParticipants)
    .where(and(eq(schema.outingParticipants.outingId, outingId), isNotNull(schema.outingParticipants.userId)));
  for (const s of seated) {
    if (!s.userId || s.userId === hostId) continue;
    await notify(db, {
      recipientId: s.userId,
      actorId: hostId,
      category: "outing",
      subjectId: row.joinCode,
      data: { event: "recap", outingTitle: row.title, distillery: row.distilleryName },
      dedupeKey: `outing_recap:${row.id}`,
    });
  }
  return row;
}

/** The host deletes the outing and everything logged on it. */
export async function deleteOuting(db: DB, hostId: string, outingId: string) {
  const rows = await db
    .delete(schema.outings)
    .where(and(eq(schema.outings.id, outingId), eq(schema.outings.hostId, hostId)))
    .returning({ id: schema.outings.id });
  return rows.length > 0;
}

/** People the host may invite in-app: mutual follows who are reachable, not blocked, and not already on the trip. */
export async function listInvitableFriends(db: DB, userId: string, outingId: string) {
  return db
    .select({ userId: schema.userProfiles.userId, handle: schema.userProfiles.handle, displayName: schema.userProfiles.displayName })
    .from(schema.userProfiles)
    .where(
      and(
        eq(schema.userProfiles.socialEnabled, true),
        isNull(schema.userProfiles.suspendedAt),
        acceptedFollowSql(userId, schema.userProfiles.userId),
        acceptedFollowSql(schema.userProfiles.userId, userId),
        sql`not exists (select 1 from blocks b where (b.blocker_id = ${userId} and b.blocked_id = ${schema.userProfiles.userId}) or (b.blocker_id = ${schema.userProfiles.userId} and b.blocked_id = ${userId}))`,
        sql`not exists (select 1 from outing_participants op where op.outing_id = ${outingId} and op.user_id = ${schema.userProfiles.userId})`,
      ),
    )
    .orderBy(asc(schema.userProfiles.handle))
    .limit(100);
}

/** Send in-app invites to the chosen friends. Only mutual friends count; returns how many were sent. */
export async function inviteFriends(db: DB, hostId: string, outing: schema.Outing, userIds: string[]) {
  if (outing.hostId !== hostId || outing.state !== "open") return 0;
  const allowed = new Set((await listInvitableFriends(db, hostId, outing.id)).map((f) => f.userId));
  let sent = 0;
  for (const id of new Set(userIds)) {
    if (!allowed.has(id)) continue;
    if (await inviteNotice(db, outing, hostId, id)) sent++;
  }
  return sent;
}

// ── The view ────────────────────────────────────────────────────────────────

export interface OutingFeedItem {
  kind: "tasting" | "note";
  id: string;
  who: string;
  mine: boolean;
  /** Tasting only. */
  label?: string;
  bottleId?: string | null;
  rating?: number | null;
  tags?: string[];
  flavorTags?: Record<string, number> | null;
  /** The note on a tasting, or a feed note's body. */
  text: string | null;
  createdAt: Date;
}

export interface OutingRecapBottle {
  label: string;
  bottleId: string | null;
  average: number | null;
  /** Descriptors two or more people named. */
  sharedTags: string[];
}

export interface OutingRecap {
  bottles: OutingRecapBottle[];
  favorite: (OutingRecapBottle & { consensus: boolean }) | null;
  /** Share of every descriptor named, by flavour family — percentages, never counts. */
  spread: Array<{ id: string; label: string; color: string; share: number }>;
  topTags: string[];
}

export interface OutingView {
  id: string;
  title: string;
  distilleryName: string;
  distilleryId: string | null;
  location: string | null;
  visitOn: string;
  rideReminder: boolean;
  state: schema.OutingState;
  joinCode: string;
  isHost: boolean;
  host: { handle: string; displayName: string } | null;
  club: { id: string; name: string } | null;
  seat: OutingSeat | null;
  people: Array<{ name: string; guest: boolean }>;
  /** Only for the host and people on the trip — a bystander with the link sees the join screen. */
  feed: OutingFeedItem[];
  recap: OutingRecap | null;
  /** The shared bottle list with everyone's verdicts (trip members only). */
  board: OutingBoardBottle[];
  /** Changes whenever something visible changes — the client polls it. */
  stamp: string;
}

const tagNames = (tags: Record<string, number> | null, n = 3) =>
  Object.entries(tags ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => leafLabel(id) ?? id);

const normLabel = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Pure: the end-of-outing recap from the visible tastings. */
export function buildRecap(rows: Array<{ label: string; bottleId: string | null; rating: number | null; flavorTags: Record<string, number> | null; participantId: string }>): OutingRecap {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.bottleId ? `b:${r.bottleId}` : `l:${normLabel(r.label)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  // `mean` is the unrounded average: ranking on the rounded one could crown a
  // lower-rated bottle when two round to the same tenth.
  const bottles: Array<OutingRecapBottle & { raters: number; mean: number | null }> = [];
  for (const g of groups.values()) {
    // One voice per person per bottle: a second taste of the same thing is the
    // same opinion, and must not weigh the consensus (or count for anything).
    const perPerson = new Map<string, number[]>();
    const tagPeople = new Map<string, Set<string>>();
    for (const r of g) {
      if (r.rating != null) perPerson.set(r.participantId, [...(perPerson.get(r.participantId) ?? []), r.rating]);
      for (const t of Object.keys(r.flavorTags ?? {})) tagPeople.set(t, new Set([...(tagPeople.get(t) ?? []), r.participantId]));
    }
    const votes = [...perPerson.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    const mean = votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : null;
    bottles.push({
      label: g[0].label,
      bottleId: g[0].bottleId,
      average: mean == null ? null : Math.round(mean * 10) / 10,
      mean,
      sharedTags: [...tagPeople.entries()]
        .filter(([, p]) => p.size >= 2)
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, 4)
        .map(([t]) => leafLabel(t) ?? t),
      raters: votes.length,
    });
  }
  bottles.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  const rank = (a: (typeof bottles)[number], b: (typeof bottles)[number]) =>
    (b.mean ?? 0) - (a.mean ?? 0) || b.raters - a.raters || a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  const agreed = bottles.filter((b) => b.raters >= 2 && b.average != null).sort(rank);
  const anyRated = bottles.filter((b) => b.average != null).sort(rank);
  const fav = agreed[0] ?? anyRated[0] ?? null;

  const family = new Map<string, number>();
  const leaf = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    for (const t of Object.keys(r.flavorTags ?? {})) {
      const w = wedgeForLeaf(t);
      if (!w) continue;
      family.set(w, (family.get(w) ?? 0) + 1);
      leaf.set(t, (leaf.get(t) ?? 0) + 1);
      total++;
    }
  }
  const spread = FLAVOR_WHEEL.filter((w) => family.has(w.id))
    .map((w) => ({ id: w.id, label: w.label, color: w.color, share: Math.round(((family.get(w.id) ?? 0) / total) * 100) }))
    .sort((a, b) => b.share - a.share);

  const strip = (b: (typeof bottles)[number]): OutingRecapBottle => ({ label: b.label, bottleId: b.bottleId, average: b.average, sharedTags: b.sharedTags });
  return {
    bottles: bottles.map(strip),
    favorite: fav ? { ...strip(fav), consensus: fav.raters >= 2 } : null,
    spread,
    topTags: [...leaf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => leafLabel(t) ?? t),
  };
}

export interface OutingBoardVote {
  who: string;
  mine: boolean;
  rating: number | null;
  note: string | null;
  tags: string[];
}

/**
 * One bottle on the outing's shared list with what everyone thought of it.
 * Ratings, notes and descriptors only — no pours, amounts or per-person
 * counts exist here to show (docs/RESPONSIBLE hard rules).
 */
export interface OutingBoardBottle {
  key: string;
  /** The list entry; null for a bottle only known from a tasting logged before the list existed. */
  entryId: string | null;
  label: string;
  bottleId: string | null;
  addedBy: string | null;
  addedByMe: boolean;
  votes: OutingBoardVote[];
  /** People on the trip who haven't rated it yet. */
  notYet: string[];
  average: number | null;
  /** Descriptors across everyone's wheels, most-named first. */
  groupTags: string[];
  favourite: boolean;
  /** The viewer's own tasting of this bottle, to edit in place. */
  mine: { id: string; rating: number | null; flavorTags: Record<string, number> | null; note: string | null } | null;
}

interface BoardEntryRow {
  id: string;
  participantId: string;
  bottleId: string | null;
  label: string;
  dedupeKey: string;
  createdAt: Date;
}
interface BoardTastingRow {
  id: string;
  participantId: string;
  bottleId: string | null;
  label: string;
  rating: number | null;
  flavorTags: Record<string, number> | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Pure: the per-bottle group view. `people` is the visible trip (participant
 * id → display name); rows from anyone outside it must already be filtered.
 * One voice per person per bottle — their latest tasting.
 */
export function buildBottleBoard(
  entries: BoardEntryRow[],
  tastings: BoardTastingRow[],
  people: Array<{ participantId: string; name: string }>,
  viewerParticipantId: string | null,
): OutingBoardBottle[] {
  const names = new Map(people.map((p) => [p.participantId, p.name]));
  const byKey = new Map<string, { entry: BoardEntryRow | null; label: string; bottleId: string | null; at: number }>();
  for (const e of [...entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (!byKey.has(e.dedupeKey)) byKey.set(e.dedupeKey, { entry: e, label: e.label, bottleId: e.bottleId, at: e.createdAt.getTime() });
  }
  const latest = new Map<string, Map<string, BoardTastingRow>>();
  for (const t of tastings) {
    const key = outingBottleKey(t.bottleId, t.label);
    if (!byKey.has(key)) byKey.set(key, { entry: null, label: t.label, bottleId: t.bottleId, at: t.createdAt.getTime() });
    const per = latest.get(key) ?? new Map<string, BoardTastingRow>();
    const prev = per.get(t.participantId);
    if (!prev || prev.updatedAt.getTime() < t.updatedAt.getTime()) per.set(t.participantId, t);
    latest.set(key, per);
  }
  const out: Array<OutingBoardBottle & { mean: number | null; raters: number; at: number }> = [];
  for (const [key, b] of byKey) {
    const per = latest.get(key) ?? new Map<string, BoardTastingRow>();
    const votes: OutingBoardVote[] = [];
    const tagPeople = new Map<string, number>();
    const ratings: number[] = [];
    for (const p of people) {
      const t = per.get(p.participantId);
      if (!t) continue;
      votes.push({ who: p.name, mine: p.participantId === viewerParticipantId, rating: t.rating, note: t.note, tags: tagNames(t.flavorTags) });
      if (t.rating != null) ratings.push(t.rating);
      for (const tag of Object.keys(t.flavorTags ?? {})) tagPeople.set(tag, (tagPeople.get(tag) ?? 0) + 1);
    }
    const mean = ratings.length ? ratings.reduce((a, c) => a + c, 0) / ratings.length : null;
    const own = viewerParticipantId ? per.get(viewerParticipantId) : undefined;
    out.push({
      key,
      entryId: b.entry?.id ?? null,
      label: b.label,
      bottleId: b.bottleId,
      addedBy: b.entry ? (names.get(b.entry.participantId) ?? null) : null,
      addedByMe: !!b.entry && b.entry.participantId === viewerParticipantId,
      votes,
      notYet: people.filter((p) => !per.has(p.participantId)).map((p) => p.name),
      average: mean == null ? null : Math.round(mean * 10) / 10,
      groupTags: [...tagPeople.entries()]
        .sort((a, c) => c[1] - a[1])
        .slice(0, 5)
        .map(([t]) => leafLabel(t) ?? t),
      favourite: false,
      mine: own ? { id: own.id, rating: own.rating, flavorTags: own.flavorTags, note: own.note } : null,
      mean,
      raters: ratings.length,
      at: b.at,
    });
  }
  // Group favourite: best unrounded mean among bottles two or more people rated,
  // else the best rated at all (ties: more raters, then name).
  const rank = (a: (typeof out)[number], c: (typeof out)[number]) =>
    (c.mean ?? 0) - (a.mean ?? 0) || c.raters - a.raters || a.label.localeCompare(c.label, undefined, { sensitivity: "base" });
  const fav = out.filter((x) => x.raters >= 2).sort(rank)[0] ?? out.filter((x) => x.mean != null).sort(rank)[0];
  if (fav) fav.favourite = true;
  return out
    .sort((a, c) => a.at - c.at)
    .map((x): OutingBoardBottle => ({
      key: x.key,
      entryId: x.entryId,
      label: x.label,
      bottleId: x.bottleId,
      addedBy: x.addedBy,
      addedByMe: x.addedByMe,
      votes: x.votes,
      notYet: x.notYet,
      average: x.average,
      groupTags: x.groupTags,
      favourite: x.favourite,
      mine: x.mine,
    }));
}

/**
 * The participants a viewer may see on an outing: guests (unexpired), the
 * viewer themself, and social-enabled, unsuspended accounts with no block
 * either way. Shared by the outing view and Home's counts so both agree.
 */
function participantVisibleSql(viewer: string) {
  return and(
    sql`(${schema.outingParticipants.userId} is null or ${schema.outingParticipants.userId} = ${viewer} or (
          exists (select 1 from user_profiles fp where fp.user_id = ${schema.outingParticipants.userId} and fp.social_enabled = true and fp.suspended_at is null)
          and not exists (select 1 from blocks b where (b.blocker_id = ${viewer} and b.blocked_id = ${schema.outingParticipants.userId}) or (b.blocker_id = ${schema.outingParticipants.userId} and b.blocked_id = ${viewer}))
        ))`,
    sql`(${schema.outingParticipants.userId} is not null or ${schema.outingParticipants.expiresAt} > now())`,
  )!;
}

export async function getOutingView(db: DB, outing: schema.Outing, viewerUserId: string | null, seat: OutingSeat | null): Promise<OutingView> {
  const isHost = viewerUserId === outing.hostId;
  const hostProfile = await db.query.userProfiles.findFirst({
    columns: { handle: true, displayName: true },
    where: eq(schema.userProfiles.userId, outing.hostId),
  });
  const club = outing.clubId
    ? ((await db.query.clubs.findFirst({ columns: { id: true, name: true }, where: eq(schema.clubs.id, outing.clubId) })) ?? null)
    : null;

  // Who's on the trip, minus anyone the viewer is blocked with, suspended or
  // stepped-back accounts, and expired guests — the same filter as a table.
  const viewer = viewerUserId ?? "";
  const people = await db
    .select({
      participantId: schema.outingParticipants.id,
      userId: schema.outingParticipants.userId,
      guestName: schema.outingParticipants.guestName,
      handle: schema.userProfiles.handle,
      displayName: schema.userProfiles.displayName,
    })
    .from(schema.outingParticipants)
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.outingParticipants.userId))
    .where(
      and(
        eq(schema.outingParticipants.outingId, outing.id),
        participantVisibleSql(viewer),
      ),
    )
    .orderBy(asc(schema.outingParticipants.joinedAt));
  const visible = new Map(people.map((p) => [p.participantId, p]));
  const nameOf = (pid: string) => {
    const p = visible.get(pid)!;
    return p.handle ? p.displayName || `@${p.handle}` : (p.guestName ?? "Guest");
  };

  const onTrip = !!seat || isHost;
  let feed: OutingFeedItem[] = [];
  let recap: OutingRecap | null = null;
  let board: OutingBoardBottle[] = [];
  let stamp = `${outing.state}`;
  if (onTrip) {
    const tastings = (
      await db.select().from(schema.outingTastings).where(eq(schema.outingTastings.outingId, outing.id)).orderBy(desc(schema.outingTastings.createdAt))
    ).filter((t) => t.hiddenAt == null && visible.has(t.participantId));
    const notes = (
      await db.select().from(schema.outingNotes).where(eq(schema.outingNotes.outingId, outing.id)).orderBy(desc(schema.outingNotes.createdAt))
    ).filter((n) => n.hiddenAt == null && visible.has(n.participantId));
    feed = [
      ...tastings.map(
        (t): OutingFeedItem => ({
          kind: "tasting",
          id: t.id,
          who: nameOf(t.participantId),
          mine: seat?.participantId === t.participantId,
          label: t.label,
          // A link to the bottle page only when this viewer may open it.
          bottleId: t.bottleId,
          rating: t.rating,
          tags: tagNames(t.flavorTags),
          flavorTags: t.flavorTags,
          text: t.note,
          createdAt: t.createdAt,
        }),
      ),
      ...notes.map((n): OutingFeedItem => ({ kind: "note", id: n.id, who: nameOf(n.participantId), mine: seat?.participantId === n.participantId, text: n.body, createdAt: n.createdAt })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const linkable = new Set<string>();
    const ids = [...new Set(tastings.map((t) => t.bottleId).filter((x): x is string => !!x))];
    for (const id of ids) {
      const b = await db.query.bottles.findFirst({ columns: { status: true, submittedBy: true }, where: eq(schema.bottles.id, id) });
      if (b && canViewBottle(b, viewerUserId ?? undefined)) linkable.add(id);
    }
    for (const f of feed) if (f.kind === "tasting" && f.bottleId && !linkable.has(f.bottleId)) f.bottleId = null;
    recap = buildRecap(tastings.map((t) => ({ ...t, bottleId: t.bottleId && linkable.has(t.bottleId) ? t.bottleId : null })));
    const entries = (
      await db.select().from(schema.outingBottles).where(eq(schema.outingBottles.outingId, outing.id)).orderBy(asc(schema.outingBottles.createdAt))
    ).filter((e) => e.hiddenAt == null && visible.has(e.participantId));
    for (const id of new Set(entries.map((e) => e.bottleId).filter((x): x is string => !!x && !ids.includes(x)))) {
      const b = await db.query.bottles.findFirst({ columns: { status: true, submittedBy: true }, where: eq(schema.bottles.id, id) });
      if (b && canViewBottle(b, viewerUserId ?? undefined)) linkable.add(id);
    }
    board = buildBottleBoard(
      entries,
      tastings,
      people.map((p) => ({ participantId: p.participantId, name: p.participantId === seat?.participantId ? "You" : nameOf(p.participantId) })),
      seat?.participantId ?? null,
    );
    for (const b of board) if (b.bottleId && !linkable.has(b.bottleId)) b.bottleId = null;
    stamp = [outing.state, feed.length, entries.length, entries.at(-1)?.id ?? "", ...feed.slice(0, 3).map((f) => f.id), tastings.reduce((m, t) => Math.max(m, t.updatedAt.getTime()), 0), people.length].join(":");
  }

  return {
    id: outing.id,
    title: outing.title,
    distilleryName: outing.distilleryName,
    distilleryId: outing.distilleryId,
    location: outing.location,
    visitOn: outing.visitOn,
    rideReminder: outing.rideReminder,
    state: outing.state,
    joinCode: outing.joinCode,
    isHost,
    host: hostProfile ? { handle: hostProfile.handle, displayName: hostProfile.displayName ?? "" } : null,
    club,
    seat,
    people: people.map((p) => ({ name: p.handle ? `@${p.handle}` : (p.guestName ?? "Guest"), guest: !p.userId })),
    feed,
    recap,
    board,
    stamp,
  };
}

/** What the outing's poll returns: just enough to know whether to refresh. */
export async function outingStamp(db: DB, outing: schema.Outing, viewerUserId: string | null, seat: OutingSeat | null) {
  return (await getOutingView(db, outing, viewerUserId, seat)).stamp;
}

/** The outing as CSV — for anyone on it. Names, ratings, descriptors, notes; no amounts exist to export. */
export function outingCsv(view: OutingView): string {
  // Every descriptor recorded, not the three the feed shows.
  const rows = view.feed.map((f) => [f.kind, f.who, f.label ?? "", f.rating ?? "", tagNames(f.flavorTags ?? null, 8).join("; "), f.text ?? "", f.createdAt.toISOString()]);
  return toCsv(["kind", "who", "bottle", "rating", "descriptors", "note", "at"], rows);
}

export const formatVisitDay = (visitOn: string) =>
  new Date(`${visitOn}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** SQL twin of `outingVisibleTo` for list projections. */
function hostVisibleSql(viewerId: string) {
  return sql`(${schema.outings.hostId} = ${viewerId} or (
    exists (select 1 from user_profiles hp where hp.user_id = ${schema.outings.hostId} and hp.social_enabled = true and hp.suspended_at is null)
    and not exists (select 1 from blocks b where (b.blocker_id = ${viewerId} and b.blocked_id = ${schema.outings.hostId}) or (b.blocker_id = ${schema.outings.hostId} and b.blocked_id = ${viewerId}))
  ))`;
}

export async function listMyOutings(db: DB, userId: string) {
  if (await isSuspended(db, userId)) return [];
  return db
    .select({
      id: schema.outings.id,
      title: schema.outings.title,
      distilleryName: schema.outings.distilleryName,
      visitOn: schema.outings.visitOn,
      joinCode: schema.outings.joinCode,
      state: schema.outings.state,
    })
    .from(schema.outingParticipants)
    .innerJoin(schema.outings, eq(schema.outings.id, schema.outingParticipants.outingId))
    .where(and(eq(schema.outingParticipants.userId, userId), hostVisibleSql(userId)))
    .orderBy(desc(schema.outings.visitOn), desc(schema.outings.createdAt))
    .limit(20);
}

/**
 * The soonest open outing on or after `today` (YYYY-MM-DD) the user is part
 * of — the Home / Social "Get together" lead. Its own query rather than a
 * filter over `listMyOutings`, whose newest-first 20-row window could drop
 * the nearest trip for someone with many planned.
 */
export async function nextOutingFor(db: DB, userId: string, today: string) {
  if (await isSuspended(db, userId)) return null;
  const [row] = await db
    .select({
      id: schema.outings.id,
      title: schema.outings.title,
      distilleryName: schema.outings.distilleryName,
      visitOn: schema.outings.visitOn,
      joinCode: schema.outings.joinCode,
      state: schema.outings.state,
    })
    .from(schema.outingParticipants)
    .innerJoin(schema.outings, eq(schema.outings.id, schema.outingParticipants.outingId))
    .where(and(eq(schema.outingParticipants.userId, userId), eq(schema.outings.state, "open"), gte(schema.outings.visitOn, today), hostVisibleSql(userId)))
    .orderBy(asc(schema.outings.visitOn), asc(schema.outings.createdAt))
    .limit(1);
  if (!row) return null;
  // "Who's coming" and the bottle list, as counts only: names would need the
  // per-viewer block predicate, and Home only needs the shape of the plan.
  const [[going], [listed]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.outingParticipants)
      .where(and(eq(schema.outingParticipants.outingId, row.id), participantVisibleSql(userId))),
    // Only entries from participants this viewer can see, as on the outing page.
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.outingBottles)
      .innerJoin(schema.outingParticipants, eq(schema.outingParticipants.id, schema.outingBottles.participantId))
      .where(and(eq(schema.outingBottles.outingId, row.id), isNull(schema.outingBottles.hiddenAt), participantVisibleSql(userId))),
  ]);
  const { id: _id, ...rest } = row;
  void _id;
  return { ...rest, goingCount: Number(going?.count ?? 0), bottleCount: Number(listed?.count ?? 0) };
}

/** Nightly + opportunistic: guest seats past 24 h, and what they logged with them (D20). */
export async function sweepOutingGuests(db: DB, now = new Date()): Promise<void> {
  await db
    .delete(schema.outingParticipants)
    .where(and(isNull(schema.outingParticipants.userId), lt(schema.outingParticipants.expiresAt, now)));
}

import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { FLIGHT_SLOTS, type FlightSlot, type FlightState } from "@/db/schema";
import { ageOn, isValidBirthDate, minimumAgeFor, OFFERED_MARKETS } from "@/lib/age-gate";
import { leafLabel } from "@/lib/flavor-wheel";
import { getRole, newCode, toCsv } from "@/lib/clubs";
import { notify } from "@/lib/notify";

/**
 * Tasting nights / blind flights (docs/SOCIAL.md §7.9, D20; design board
 * C3/C4). The install loop: a host sets 3–6 bottles behind letters, the
 * table joins by link or QR, everyone rates privately, and the host reveals
 * for everyone at once.
 *
 * Guests (D20): no account for 24 hours, after the same 21+ birth-date check
 * an account answers (the date is checked, not stored). A guest holds an
 * httpOnly bearer cookie whose SHA-256 is the only thing kept; their ratings
 * are swept at 24 h unless they create an account and claim them.
 *
 * Privacy at the table: before reveal nobody sees anybody's ratings (not even
 * the host); a blocked pair never see each other's notes; a suspended
 * account's notes vanish; the host can hide a note. No volumes, no prices.
 */

export const GUEST_HOURS = 24;
export const GUEST_COOKIE = "whaikey_flight_guest";

export const flightCreateSchema = z
  .object({
    title: z.string().trim().min(2).max(80),
    blind: z.boolean().default(true),
    clubId: z.string().min(1).max(64).optional(),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    bottleIds: z.array(z.string().min(1).max(128)).min(3).max(6),
  })
  .strict()
  .refine((v) => new Set(v.bottleIds).size === v.bottleIds.length, "a bottle can only be poured once");

export const entrySchema = z
  .object({
    slot: z.enum(FLIGHT_SLOTS),
    rating: z.number().min(0.5).max(5).multipleOf(0.5).nullable().optional(),
    flavorTags: z.record(z.string().max(40), z.number().int().min(1).max(3)).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => !v.flavorTags || Object.keys(v.flavorTags).every((k) => leafLabel(k) != null), "unknown flavor tag")
  .refine((v) => !v.flavorTags || Object.keys(v.flavorTags).length <= 8, "at most 8 flavor tags");

export const guestJoinSchema = z
  .object({
    guestName: z.string().trim().min(1).max(30),
    birthDate: z.string().refine(isValidBirthDate, "invalid birth date"),
    market: z.enum(OFFERED_MARKETS.map((m) => m.code) as [string, ...string[]]),
  })
  .strict();

export class FlightClubError extends Error {
  constructor() {
    super("not_a_member");
  }
}

export const hashGuestToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createFlight(db: DB, hostId: string, input: z.infer<typeof flightCreateSchema>) {
  if (input.clubId && (await getRole(db, input.clubId, hostId)) == null) throw new FlightClubError();
  // Catalog bottles only: a pending submission is visible to its submitter
  // alone, and would put a stranger's private entry on everyone's table.
  const found = await db
    .select({ id: schema.bottles.id })
    .from(schema.bottles)
    .where(and(inArray(schema.bottles.id, input.bottleIds), ne(schema.bottles.status, "user_submitted")));
  if (found.length !== input.bottleIds.length) return null;
  const flight = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.flights)
      .values({
        id: crypto.randomUUID(),
        hostId,
        clubId: input.clubId ?? null,
        title: input.title,
        blind: input.blind,
        joinCode: newCode(10),
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      })
      .returning();
    await tx.insert(schema.flightBottles).values(
      input.bottleIds.map((bottleId, i) => ({ flightId: row.id, slot: FLIGHT_SLOTS[i], bottleId })),
    );
    await tx.insert(schema.flightParticipants).values({ id: crypto.randomUUID(), flightId: row.id, userId: hostId });
    return row;
  });
  if (flight.clubId) {
    const members = await db
      .select({ userId: schema.clubMembers.userId })
      .from(schema.clubMembers)
      .where(eq(schema.clubMembers.clubId, flight.clubId));
    for (const m of members) {
      await notify(db, {
        recipientId: m.userId,
        actorId: hostId,
        category: "flight",
        subjectId: flight.joinCode,
        data: { event: "invite", flightTitle: flight.title },
        dedupeKey: `flight_invite:${flight.id}`,
      });
    }
  }
  return flight;
}

export async function flightByCode(db: DB, code: string) {
  if (!/^[a-z0-9]{6,16}$/.test(code)) return null;
  return (await db.query.flights.findFirst({ where: eq(schema.flights.joinCode, code) })) ?? null;
}

/**
 * The host-side read-path check (SOCIAL §13): a flight is reachable only while
 * its host is socially present and unsuspended, and never across a block
 * between host and viewer. The host always reaches their own.
 */
export async function flightVisibleTo(db: DB, flight: schema.Flight, viewerUserId: string | null): Promise<boolean> {
  if (viewerUserId === flight.hostId) return true;
  const host = await db.query.userProfiles.findFirst({
    columns: { socialEnabled: true, suspendedAt: true },
    where: eq(schema.userProfiles.userId, flight.hostId),
  });
  if (!host || !host.socialEnabled || host.suspendedAt != null) return false;
  if (viewerUserId && (await blockedEither(db, flight.hostId, viewerUserId))) return false;
  return true;
}

/** `flightByCode` plus `flightVisibleTo` — what every route and page should use. */
export async function visibleFlightByCode(db: DB, code: string, viewerUserId: string | null) {
  const flight = await flightByCode(db, code);
  if (!flight || !(await flightVisibleTo(db, flight, viewerUserId))) return null;
  return flight;
}

export interface Taster {
  participantId: string;
  userId: string | null;
  guest: boolean;
}

/** The viewer's seat at this flight, from their account or their guest cookie. */
export async function findTaster(
  db: DB,
  flightId: string,
  who: { userId?: string | null; guestToken?: string | null },
  now = new Date(),
): Promise<Taster | null> {
  if (who.userId) {
    const row = await db.query.flightParticipants.findFirst({
      where: and(eq(schema.flightParticipants.flightId, flightId), eq(schema.flightParticipants.userId, who.userId)),
    });
    if (row) return { participantId: row.id, userId: row.userId, guest: false };
  }
  if (who.guestToken) {
    const row = await db.query.flightParticipants.findFirst({
      where: and(
        eq(schema.flightParticipants.flightId, flightId),
        eq(schema.flightParticipants.guestTokenHash, hashGuestToken(who.guestToken)),
        isNull(schema.flightParticipants.userId),
      ),
    });
    if (row && row.expiresAt && row.expiresAt > now) return { participantId: row.id, userId: null, guest: true };
  }
  return null;
}

async function blockedEither(db: DB, a: string, b: string) {
  const rows = await db
    .select({ id: schema.blocks.id })
    .from(schema.blocks)
    .where(sql`(${schema.blocks.blockerId} = ${a} and ${schema.blocks.blockedId} = ${b}) or (${schema.blocks.blockerId} = ${b} and ${schema.blocks.blockedId} = ${a})`)
    .limit(1);
  return rows.length > 0;
}

export type JoinOutcome = { participantId: string } | { error: "closed" | "blocked" | "underage" };

export async function joinAsUser(db: DB, flightId: string, userId: string): Promise<JoinOutcome> {
  const flight = await db.query.flights.findFirst({ where: eq(schema.flights.id, flightId) });
  if (!flight || flight.state === "closed") return { error: "closed" };
  if (await blockedEither(db, flight.hostId, userId)) return { error: "blocked" };
  const existing = await findTaster(db, flightId, { userId });
  if (existing) return { participantId: existing.participantId };
  const [row] = await db
    .insert(schema.flightParticipants)
    .values({ id: crypto.randomUUID(), flightId, userId })
    .onConflictDoNothing()
    .returning();
  if (row) return { participantId: row.id };
  const raced = await findTaster(db, flightId, { userId });
  return raced ? { participantId: raced.participantId } : { error: "closed" };
}

/**
 * A guest's seat (D20). The birth date is checked against the market's
 * minimum (21 in the US) exactly as the account gate does — and then
 * discarded. Fails closed on an invalid date.
 */
export async function joinAsGuest(
  db: DB,
  flightId: string,
  input: z.infer<typeof guestJoinSchema>,
  now = new Date(),
): Promise<(JoinOutcome & { token?: string; expiresAt?: Date })> {
  const flight = await db.query.flights.findFirst({ where: eq(schema.flights.id, flightId) });
  if (!flight || flight.state === "closed") return { error: "closed" };
  if (ageOn(input.birthDate, now) < minimumAgeFor(input.market)) return { error: "underage" };
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + GUEST_HOURS * 3600_000);
  const [row] = await db
    .insert(schema.flightParticipants)
    .values({
      id: crypto.randomUUID(),
      flightId,
      guestTokenHash: hashGuestToken(token),
      guestName: input.guestName,
      joinedAt: now,
      expiresAt,
    })
    .returning();
  return { participantId: row.id, token, expiresAt };
}

export async function saveEntry(db: DB, flightId: string, taster: Taster, input: z.infer<typeof entrySchema>) {
  const flight = await db.query.flights.findFirst({ where: eq(schema.flights.id, flightId) });
  if (!flight || flight.state !== "open") return null;
  const slot = await db.query.flightBottles.findFirst({
    where: and(eq(schema.flightBottles.flightId, flightId), eq(schema.flightBottles.slot, input.slot)),
  });
  if (!slot) return null;
  const values = {
    rating: input.rating ?? null,
    flavorTags: input.flavorTags ?? null,
    note: input.note || null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(schema.flightEntries)
    .values({ id: crypto.randomUUID(), participantId: taster.participantId, flightId, slot: input.slot, ...values })
    .onConflictDoUpdate({ target: [schema.flightEntries.participantId, schema.flightEntries.slot], set: values })
    .returning();
  return row;
}

export async function setFlightState(db: DB, hostId: string, flightId: string, to: Exclude<FlightState, "open">) {
  const from: FlightState = to === "revealed" ? "open" : "revealed";
  const now = new Date();
  const [row] = await db
    .update(schema.flights)
    .set(to === "revealed" ? { state: to, revealedAt: now } : { state: to, closedAt: now })
    .where(and(eq(schema.flights.id, flightId), eq(schema.flights.hostId, hostId), inArray(schema.flights.state, [from, to])))
    .returning();
  if (!row) return null;
  if (to === "revealed") {
    const tasters = await db
      .select({ userId: schema.flightParticipants.userId })
      .from(schema.flightParticipants)
      .where(and(eq(schema.flightParticipants.flightId, flightId), isNotNull(schema.flightParticipants.userId)));
    for (const t of tasters) {
      if (!t.userId) continue;
      await notify(db, {
        recipientId: t.userId,
        actorId: t.userId === hostId ? null : hostId,
        category: "flight",
        subjectId: row.joinCode,
        data: { event: "revealed", flightTitle: row.title },
        dedupeKey: `flight_revealed:${flightId}`,
      });
    }
  }
  return row;
}

/** The host hides one note from the table (moderation hook, §11). */
export async function hideEntry(db: DB, hostId: string, entryId: string): Promise<boolean> {
  const entry = await db.query.flightEntries.findFirst({ where: eq(schema.flightEntries.id, entryId) });
  if (!entry) return false;
  const flight = await db.query.flights.findFirst({ where: eq(schema.flights.id, entry.flightId) });
  if (!flight || flight.hostId !== hostId) return false;
  await db.update(schema.flightEntries).set({ hiddenAt: new Date() }).where(eq(schema.flightEntries.id, entryId));
  return true;
}

/** A guest who signed up keeps their ratings: the seat moves to the account. */
export async function claimGuestSeat(db: DB, flightId: string, guestToken: string, userId: string, now = new Date()) {
  const guest = await findTaster(db, flightId, { guestToken }, now);
  if (!guest) return false;
  const mine = await findTaster(db, flightId, { userId }, now);
  if (!mine) {
    await db
      .update(schema.flightParticipants)
      .set({ userId, guestTokenHash: null, expiresAt: null })
      .where(eq(schema.flightParticipants.id, guest.participantId));
    return true;
  }
  // Already seated with the account: keep the account's entries, take the guest's for empty slots.
  const have = new Set(
    (await db.select({ slot: schema.flightEntries.slot }).from(schema.flightEntries).where(eq(schema.flightEntries.participantId, mine.participantId))).map((r) => r.slot),
  );
  const theirs = await db.select().from(schema.flightEntries).where(eq(schema.flightEntries.participantId, guest.participantId));
  for (const e of theirs) {
    if (have.has(e.slot)) continue;
    await db.update(schema.flightEntries).set({ participantId: mine.participantId }).where(eq(schema.flightEntries.id, e.id));
  }
  await db.delete(schema.flightParticipants).where(eq(schema.flightParticipants.id, guest.participantId));
  return true;
}

/** Nightly + opportunistic: guest seats past 24 h, and their ratings with them (D20). */
export async function sweepGuests(db: DB, now = new Date()): Promise<void> {
  await db
    .delete(schema.flightParticipants)
    .where(and(isNull(schema.flightParticipants.userId), lt(schema.flightParticipants.expiresAt, now)));
}

export interface SlotResultEntry {
  entryId: string;
  name: string;
  handle: string | null;
  rating: number | null;
  tags: string[];
  note: string | null;
  mine: boolean;
}

export interface FlightSlotView {
  slot: FlightSlot;
  /** Null while hidden: a blind flight before reveal, for everyone but the host. */
  bottle: { id: string; name: string; country: string | null; region: string | null } | null;
  mine: { rating: number | null; flavorTags: Record<string, number> | null; note: string | null } | null;
  /** Only after reveal. */
  results: { average: number | null; ratings: number; entries: SlotResultEntry[]; sharedTags: string[] } | null;
}

export interface FlightView {
  id: string;
  title: string;
  blind: boolean;
  state: FlightState;
  joinCode: string;
  scheduledAt: Date | null;
  isHost: boolean;
  host: { handle: string; displayName: string } | null;
  club: { id: string; name: string } | null;
  taster: Taster | null;
  tasters: Array<{ name: string; guest: boolean }>;
  slots: FlightSlotView[];
}

const topTags = (tags: Record<string, number> | null, n = 3) =>
  Object.entries(tags ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => leafLabel(id) ?? id);

/**
 * One flight as the viewer may see it. `viewerUserId` is the account (if
 * any); `taster` their seat (if any). Someone with neither sees only the
 * title, host and slot letters — enough for a join screen.
 */
export async function getFlightView(
  db: DB,
  flight: schema.Flight,
  viewerUserId: string | null,
  taster: Taster | null,
): Promise<FlightView> {
  const isHost = viewerUserId === flight.hostId;
  const reveal = flight.state !== "open";
  const hostProfile = await db.query.userProfiles.findFirst({
    columns: { handle: true, displayName: true },
    where: eq(schema.userProfiles.userId, flight.hostId),
  });
  const club = flight.clubId
    ? await db.query.clubs.findFirst({ columns: { id: true, name: true }, where: eq(schema.clubs.id, flight.clubId) })
    : null;

  const slots = await db
    .select({
      slot: schema.flightBottles.slot,
      bottleId: schema.bottles.id,
      name: schema.bottles.name,
      country: schema.bottles.country,
      region: schema.bottles.region,
    })
    .from(schema.flightBottles)
    .innerJoin(schema.bottles, eq(schema.bottles.id, schema.flightBottles.bottleId))
    .where(eq(schema.flightBottles.flightId, flight.id))
    .orderBy(asc(schema.flightBottles.slot));

  // Who's at the table, minus anyone the viewer is blocked with and suspended
  // or stepped-back accounts. Guests are named by the first name they typed.
  const viewer = viewerUserId ?? "";
  const people = await db
    .select({
      participantId: schema.flightParticipants.id,
      userId: schema.flightParticipants.userId,
      guestName: schema.flightParticipants.guestName,
      expiresAt: schema.flightParticipants.expiresAt,
      handle: schema.userProfiles.handle,
      displayName: schema.userProfiles.displayName,
    })
    .from(schema.flightParticipants)
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.flightParticipants.userId))
    .where(
      and(
        eq(schema.flightParticipants.flightId, flight.id),
        sql`(${schema.flightParticipants.userId} is null or ${schema.flightParticipants.userId} = ${viewer} or (
          exists (select 1 from user_profiles fp where fp.user_id = ${schema.flightParticipants.userId} and fp.social_enabled = true and fp.suspended_at is null)
          and not exists (select 1 from blocks b where (b.blocker_id = ${viewer} and b.blocked_id = ${schema.flightParticipants.userId}) or (b.blocker_id = ${schema.flightParticipants.userId} and b.blocked_id = ${viewer}))
        ))`,
        sql`(${schema.flightParticipants.userId} is not null or ${schema.flightParticipants.expiresAt} > now())`,
      ),
    )
    .orderBy(asc(schema.flightParticipants.joinedAt));
  const visible = new Map(people.map((p) => [p.participantId, p]));

  const entries = await db.select().from(schema.flightEntries).where(eq(schema.flightEntries.flightId, flight.id));

  return {
    id: flight.id,
    title: flight.title,
    blind: flight.blind,
    state: flight.state,
    joinCode: flight.joinCode,
    scheduledAt: flight.scheduledAt,
    isHost,
    host: hostProfile ? { handle: hostProfile.handle, displayName: hostProfile.displayName ?? "" } : null,
    club: club ?? null,
    taster,
    tasters: people.map((p) => ({ name: p.handle ? `@${p.handle}` : (p.guestName ?? "Guest"), guest: !p.userId })),
    slots: slots.map((s) => {
      const showBottle = !flight.blind || reveal || isHost;
      const mineRow = taster ? entries.find((e) => e.participantId === taster.participantId && e.slot === s.slot) : undefined;
      let results: FlightSlotView["results"] = null;
      // Results are for the table: the host and anyone seated, never a bystander holding the link.
      if (reveal && (taster || isHost)) {
        const rows = entries.filter((e) => e.slot === s.slot && e.hiddenAt == null && visible.has(e.participantId));
        const rated = rows.filter((e) => e.rating != null);
        const tagCounts = new Map<string, number>();
        for (const e of rows) for (const t of Object.keys(e.flavorTags ?? {})) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
        results = {
          average: rated.length ? Math.round((rated.reduce((a, e) => a + (e.rating ?? 0), 0) / rated.length) * 10) / 10 : null,
          ratings: rated.length,
          sharedTags: [...tagCounts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => leafLabel(t) ?? t),
          entries: rows.map((e) => {
            const p = visible.get(e.participantId)!;
            return {
              entryId: e.id,
              name: p.handle ? (p.displayName || `@${p.handle}`) : (p.guestName ?? "Guest"),
              handle: p.handle,
              rating: e.rating,
              tags: topTags(e.flavorTags),
              note: e.note,
              mine: taster?.participantId === e.participantId,
            };
          }),
        };
      }
      return {
        slot: s.slot,
        bottle: showBottle ? { id: s.bottleId, name: s.name, country: s.country, region: s.region } : null,
        mine: mineRow ? { rating: mineRow.rating, flavorTags: mineRow.flavorTags, note: mineRow.note } : null,
        results,
      };
    }),
  };
}

/** Results as CSV — for the table, after reveal. */
export function flightResultsCsv(view: FlightView): string {
  const rows: unknown[][] = [];
  for (const s of view.slots) {
    for (const e of s.results?.entries ?? []) rows.push([s.slot, s.bottle?.name ?? "", e.name, e.rating ?? "", e.tags.join("; "), e.note ?? ""]);
  }
  return toCsv(["slot", "bottle", "taster", "rating", "descriptors", "note"], rows);
}

/** An .ics invite for the scheduled time (no attendees, no tracking). */
export function flightIcs(flight: Pick<schema.Flight, "id" | "title" | "scheduledAt" | "joinCode">, origin: string): string | null {
  if (!flight.scheduledAt) return null;
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(flight.scheduledAt.getTime() + 2 * 3600_000);
  const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Whaikey//Tasting night//EN",
    "BEGIN:VEVENT",
    `UID:${flight.id}@whaikey`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(flight.scheduledAt)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(flight.title)}`,
    `URL:${origin}/f/${flight.joinCode}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

export async function listMyFlights(db: DB, userId: string) {
  return db
    .select({ title: schema.flights.title, joinCode: schema.flights.joinCode, state: schema.flights.state, createdAt: schema.flights.createdAt })
    .from(schema.flightParticipants)
    .innerJoin(schema.flights, eq(schema.flights.id, schema.flightParticipants.flightId))
    .where(eq(schema.flightParticipants.userId, userId))
    .orderBy(sql`${schema.flights.createdAt} desc`)
    .limit(20);
}

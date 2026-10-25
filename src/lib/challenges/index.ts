import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import type { ChallengeRule } from "@/db/schema";
import { MAX_TARGET, RULE_KINDS, RULE_KIND_IDS, progressFor, type MetRow, type RuleKindId } from "./kinds";

import { getRole } from "@/lib/clubs";
import { notify } from "@/lib/notify";

export { MAX_TARGET, RULE_KINDS, RULE_KIND_IDS, progressFor, type MetRow, type RuleKind, type RuleKindId } from "./kinds";

/**
 * Breadth challenges and friend breadth boards (docs/SOCIAL.md §7.12–7.13,
 * D16–D17; design board C6/C7).
 *
 * The one rule: **every mechanic counts distinct things met and saturates.**
 * A challenge's progress is `min(count(distinct X), target)` over the pours
 * logged inside its window — a second pour of a bottle you already counted
 * adds nothing, and nothing past the target adds anything. There is no rule
 * kind that counts pours, volume, ABV, days or ratings; `challenges.test.ts`
 * walks `RULE_KINDS` and fails if one appears.
 */

export const ruleSchema = z
  .object({
    kind: z.enum(RULE_KIND_IDS as [RuleKindId, ...RuleKindId[]]),
    target: z.number().int().min(1).max(MAX_TARGET),
    filter: z
      .record(z.string(), z.string().min(1).max(60))
      .refine((f) => Object.keys(f).every((k) => ["country", "region", "category"].includes(k)), "unknown filter")
      .optional(),
  })
  .strict()
  .refine((r) => Object.keys(r.filter ?? {}).every((k) => (RULE_KINDS[r.kind].filters as readonly string[]).includes(k)), "filter not allowed for this kind");

/**
 * Bottles a person met in a window, one row per pour (duplicates are harmless —
 * progress is a set). `sharedOnly` restricts to pours with an audience
 * (anything but private): what a friend's progress and the board are computed
 * from, so neither ever discloses a private pour.
 */
export async function metRows(db: DB, userId: string, from: Date, to: Date, sharedOnly: boolean): Promise<MetRow[]> {
  return db
    .select({
      bottleId: schema.bottles.id,
      distilleryId: schema.bottles.distilleryId,
      country: schema.bottles.country,
      region: schema.bottles.region,
      category: schema.bottles.category,
      caskTypes: schema.bottles.caskTypes,
      flavorTags: schema.tastingNotes.flavorTags,
    })
    .from(schema.pours)
    .innerJoin(schema.bottles, eq(schema.bottles.id, schema.pours.bottleId))
    .leftJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(
      and(
        eq(schema.pours.userId, userId),
        gte(schema.pours.createdAt, from),
        lte(schema.pours.createdAt, to),
        ne(schema.bottles.status, "user_submitted"),
        sharedOnly ? ne(schema.pours.visibility, "private") : undefined,
      ),
    );
}

// ---------------------------------------------------------------------------
// Curated monthly challenges (C6: three a month)
// ---------------------------------------------------------------------------

interface CuratedSpec {
  key: string;
  title: string;
  description: string;
  rule: ChallengeRule;
}

const ROTATION: CuratedSpec[][] = [
  [
    { key: "around-the-world", title: "Around the world", description: "Whiskey from 4 different countries this month.", rule: { kind: "distinct_countries", target: 4 } },
    { key: "islay-tour", title: "Islay tour", description: "3 different Islay distilleries.", rule: { kind: "distinct_distilleries", target: 3, filter: { region: "Islay" } } },
    { key: "cask-explorer", title: "Cask explorer", description: "3 different cask types or finishes.", rule: { kind: "distinct_cask_types", target: 3 } },
  ],
  [
    { key: "scotch-regions", title: "Scotch regions", description: "4 different Scotch regions.", rule: { kind: "distinct_regions", target: 4, filter: { country: "Scotland" } } },
    { key: "word-hunter", title: "Word hunter", description: "Name 10 different descriptors in your notes.", rule: { kind: "distinct_descriptors", target: 10 } },
    { key: "style-sampler", title: "Style sampler", description: "4 different styles — bourbon, rye, single malt, and beyond.", rule: { kind: "distinct_styles", target: 4 } },
  ],
  [
    { key: "american-distilleries", title: "American road trip", description: "4 different US distilleries.", rule: { kind: "distinct_distilleries", target: 4, filter: { country: "United States" } } },
    { key: "around-the-world", title: "Around the world", description: "Whiskey from 4 different countries this month.", rule: { kind: "distinct_countries", target: 4 } },
    { key: "word-hunter", title: "Word hunter", description: "Name 10 different descriptors in your notes.", rule: { kind: "distinct_descriptors", target: 10 } },
  ],
];

export function monthWindow(now: Date): { start: Date; end: Date; key: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1);
  return { start, end, key: start.toISOString().slice(0, 7) };
}

export function curatedFor(now: Date): Array<CuratedSpec & { slug: string; start: Date; end: Date }> {
  const w = monthWindow(now);
  const set = ROTATION[(now.getUTCFullYear() * 12 + now.getUTCMonth()) % ROTATION.length];
  return set.map((c) => ({ ...c, slug: `${w.key}-${c.key}`, start: w.start, end: w.end }));
}

/** Idempotently make sure this month's three curated challenges exist. */
export async function ensureCurated(db: DB, now = new Date()): Promise<void> {
  for (const c of curatedFor(now)) {
    await db
      .insert(schema.challenges)
      .values({
        id: crypto.randomUUID(),
        slug: c.slug,
        title: c.title,
        description: c.description,
        scope: "global",
        rule: c.rule,
        startsAt: c.start,
        endsAt: c.end,
      })
      .onConflictDoNothing();
  }
}

// ---------------------------------------------------------------------------
// Club challenges (C6: club templates over the same distinct-only kinds)
// ---------------------------------------------------------------------------

export const clubChallengeSchema = z
  .object({
    title: z.string().trim().min(2).max(60),
    rule: ruleSchema,
    days: z.number().int().min(7).max(92),
  })
  .strict();

export async function createClubChallenge(db: DB, userId: string, clubId: string, input: z.infer<typeof clubChallengeSchema>, now = new Date()) {
  const role = await getRole(db, clubId, userId);
  if (role !== "owner" && role !== "admin") return null;
  const [row] = await db
    .insert(schema.challenges)
    .values({
      id: crypto.randomUUID(),
      slug: `club-${clubId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
      title: input.title,
      description: `${RULE_KINDS[input.rule.kind].label}: ${input.rule.target} different ${RULE_KINDS[input.rule.kind].noun}.`,
      scope: "club",
      clubId,
      rule: input.rule,
      startsAt: now,
      endsAt: new Date(now.getTime() + input.days * 86_400_000),
      createdBy: userId,
    })
    .returning();
  return row;
}

/** Who may see / join a challenge: global ones everyone; club ones the club. */
async function canSee(db: DB, userId: string, c: schema.Challenge): Promise<boolean> {
  if (c.scope === "global") return true;
  return c.clubId != null && (await getRole(db, c.clubId, userId)) != null;
}

export async function joinChallenge(db: DB, userId: string, slug: string, now = new Date()): Promise<boolean> {
  const c = await db.query.challenges.findFirst({ where: eq(schema.challenges.slug, slug) });
  if (!c || c.endsAt < now || !(await canSee(db, userId, c))) return false;
  await db.insert(schema.challengeParticipants).values({ challengeId: c.id, userId }).onConflictDoNothing();
  await evaluate(db, userId, c, now);
  return true;
}

export async function leaveChallenge(db: DB, userId: string, slug: string): Promise<boolean> {
  const c = await db.query.challenges.findFirst({ where: eq(schema.challenges.slug, slug) });
  if (!c) return false;
  const rows = await db
    .delete(schema.challengeParticipants)
    .where(and(eq(schema.challengeParticipants.challengeId, c.id), eq(schema.challengeParticipants.userId, userId), isNull(schema.challengeParticipants.completedAt)))
    .returning();
  return rows.length > 0;
}

/** Recompute one person's progress; stamp the crest the first time it completes. */
async function evaluate(db: DB, userId: string, c: schema.Challenge, now: Date) {
  const rows = await metRows(db, userId, c.startsAt, c.endsAt < now ? c.endsAt : now, false);
  const p = progressFor(c.rule, rows);
  if (p.count >= p.target) {
    const stamped = await db
      .update(schema.challengeParticipants)
      .set({ completedAt: now })
      .where(and(eq(schema.challengeParticipants.challengeId, c.id), eq(schema.challengeParticipants.userId, userId), isNull(schema.challengeParticipants.completedAt)))
      .returning();
    if (stamped.length > 0) {
      await notify(db, {
        recipientId: userId,
        actorId: null,
        category: "challenge",
        subjectId: c.id,
        data: { event: "completed", challengeTitle: c.title, slug: c.slug },
        dedupeKey: `challenge_completed:${c.id}`,
      });
    }
  }
  return p;
}

export interface ChallengeCard {
  slug: string;
  title: string;
  description: string | null;
  scope: "global" | "club";
  clubName: string | null;
  startsAt: Date;
  endsAt: Date;
  joined: boolean;
  completedAt: Date | null;
  progress: { count: number; target: number };
  /** Mutual friends who joined: their completion and progress from their *shared* notes only. */
  friends: Array<{ handle: string; count: number; completed: boolean }>;
}

async function mutualFriendIds(db: DB, userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.follows.followeeId })
    .from(schema.follows)
    .where(
      and(
        eq(schema.follows.followerId, userId),
        eq(schema.follows.state, "accepted"),
        sql`exists (select 1 from follows back where back.follower_id = ${schema.follows.followeeId} and back.followee_id = ${userId} and back.state = 'accepted')`,
        sql`exists (select 1 from user_profiles fp where fp.user_id = ${schema.follows.followeeId} and fp.social_enabled = true and fp.suspended_at is null)`,
        sql`not exists (select 1 from blocks b where (b.blocker_id = ${userId} and b.blocked_id = ${schema.follows.followeeId}) or (b.blocker_id = ${schema.follows.followeeId} and b.blocked_id = ${userId}))`,
      ),
    );
  return rows.map((r) => r.id);
}

/** Active challenges the viewer can see (curated + their clubs'), with progress. */
export async function listChallenges(db: DB, userId: string, now = new Date()): Promise<ChallengeCard[]> {
  await ensureCurated(db, now);
  const clubIds = (await db.select({ id: schema.clubMembers.clubId }).from(schema.clubMembers).where(eq(schema.clubMembers.userId, userId))).map((r) => r.id);
  const active = await db
    .select({ c: schema.challenges, clubName: schema.clubs.name })
    .from(schema.challenges)
    .leftJoin(schema.clubs, eq(schema.clubs.id, schema.challenges.clubId))
    .where(
      and(
        lte(schema.challenges.startsAt, now),
        gte(schema.challenges.endsAt, now),
        clubIds.length > 0
          ? sql`(${schema.challenges.scope} = 'global' or ${inArray(schema.challenges.clubId, clubIds)})`
          : eq(schema.challenges.scope, "global"),
      ),
    )
    .orderBy(asc(schema.challenges.scope), asc(schema.challenges.endsAt));
  const friends = await mutualFriendIds(db, userId);
  const handles = new Map(
    friends.length
      ? (await db.select({ id: schema.userProfiles.userId, handle: schema.userProfiles.handle }).from(schema.userProfiles).where(inArray(schema.userProfiles.userId, friends))).map((r) => [r.id, r.handle])
      : [],
  );
  const cards: ChallengeCard[] = [];
  for (const { c, clubName } of active) {
    const mine = await db.query.challengeParticipants.findFirst({
      where: and(eq(schema.challengeParticipants.challengeId, c.id), eq(schema.challengeParticipants.userId, userId)),
    });
    const progress = mine ? await evaluate(db, userId, c, now) : progressFor(c.rule, await metRows(db, userId, c.startsAt, now, false));
    const after = mine ? await db.query.challengeParticipants.findFirst({ where: and(eq(schema.challengeParticipants.challengeId, c.id), eq(schema.challengeParticipants.userId, userId)) }) : null;
    const friendRows = friends.length
      ? await db
          .select({ userId: schema.challengeParticipants.userId, completedAt: schema.challengeParticipants.completedAt })
          .from(schema.challengeParticipants)
          .where(and(eq(schema.challengeParticipants.challengeId, c.id), inArray(schema.challengeParticipants.userId, friends)))
      : [];
    const friendCards: ChallengeCard["friends"] = [];
    for (const f of friendRows) {
      const p = progressFor(c.rule, await metRows(db, f.userId, c.startsAt, now, true));
      friendCards.push({ handle: handles.get(f.userId) ?? "", count: p.count, completed: f.completedAt != null });
    }
    cards.push({
      slug: c.slug,
      title: c.title,
      description: c.description,
      scope: c.scope,
      clubName: clubName ?? null,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      joined: !!mine,
      completedAt: after?.completedAt ?? null,
      progress: { count: progress.count, target: progress.target },
      friends: friendCards.sort((a, b) => a.handle.localeCompare(b.handle)),
    });
  }
  return cards;
}

/** Crests: every challenge the person completed, newest first (the passport's challenge page). */
export async function listCrests(db: DB, userId: string) {
  return db
    .select({ slug: schema.challenges.slug, title: schema.challenges.title, completedAt: schema.challengeParticipants.completedAt })
    .from(schema.challengeParticipants)
    .innerJoin(schema.challenges, eq(schema.challenges.id, schema.challengeParticipants.challengeId))
    .where(and(eq(schema.challengeParticipants.userId, userId), sql`${schema.challengeParticipants.completedAt} is not null`))
    .orderBy(desc(schema.challengeParticipants.completedAt));
}

/** Nightly: stamp crests for anyone who completed without opening the page. */
export async function evaluateAll(db: DB, now = new Date()): Promise<void> {
  const open = await db
    .select({ c: schema.challenges, userId: schema.challengeParticipants.userId })
    .from(schema.challengeParticipants)
    .innerJoin(schema.challenges, eq(schema.challenges.id, schema.challengeParticipants.challengeId))
    .where(and(isNull(schema.challengeParticipants.completedAt), lte(schema.challenges.startsAt, now), gte(schema.challenges.endsAt, new Date(now.getTime() - 86_400_000))));
  for (const { c, userId } of open) await evaluate(db, userId, c, now);
}

// ---------------------------------------------------------------------------
// Friend breadth board (D17; design board C7)
// ---------------------------------------------------------------------------

export const BOARD_MIN_FRIENDS = 3;
export const BOARD_KEYS = ["regions", "distilleries", "descriptors"] as const;
export type BoardKey = (typeof BOARD_KEYS)[number];

const BOARD_RULE: Record<BoardKey, RuleKindId> = {
  regions: "distinct_regions",
  distilleries: "distinct_distilleries",
  descriptors: "distinct_descriptors",
};

/** The season is the calendar quarter (UTC). */
export function seasonWindow(now: Date): { start: Date; end: Date; label: string } {
  const q = Math.floor(now.getUTCMonth() / 3);
  const start = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 1) - 1);
  return { start, end, label: `Q${q + 1} ${now.getUTCFullYear()}` };
}

export async function setBoardOptIn(db: DB, userId: string, on: boolean): Promise<void> {
  if (on) await db.insert(schema.breadthBoardOptIns).values({ userId }).onConflictDoNothing();
  else await db.delete(schema.breadthBoardOptIns).where(eq(schema.breadthBoardOptIns.userId, userId));
}

export interface BoardRow {
  rank: number;
  tied: boolean;
  handle: string;
  you: boolean;
  count: number;
}

export type Board =
  | { state: "not_opted_in" }
  | { state: "too_few"; optedInFriends: number; needed: number }
  | { state: "ready"; season: string; key: BoardKey; rows: BoardRow[] };

/**
 * Friends-only, opt-in, hidden until ≥ 3 opted-in mutual friends, season
 * window, sorted only by a distinct count; ties share a rank and say so.
 * Everyone — the viewer included — is counted from shared (non-private)
 * notes only, so the board never discloses a private pour.
 */
export async function getBoard(db: DB, userId: string, key: BoardKey, now = new Date()): Promise<Board> {
  const optedIn = await db.query.breadthBoardOptIns.findFirst({ where: eq(schema.breadthBoardOptIns.userId, userId) });
  if (!optedIn) return { state: "not_opted_in" };
  const friends = await mutualFriendIds(db, userId);
  const optedFriends = friends.length
    ? (await db.select({ id: schema.breadthBoardOptIns.userId }).from(schema.breadthBoardOptIns).where(inArray(schema.breadthBoardOptIns.userId, friends))).map((r) => r.id)
    : [];
  if (optedFriends.length < BOARD_MIN_FRIENDS) return { state: "too_few", optedInFriends: optedFriends.length, needed: BOARD_MIN_FRIENDS };
  const season = seasonWindow(now);
  const people = [userId, ...optedFriends];
  const handles = new Map(
    (await db.select({ id: schema.userProfiles.userId, handle: schema.userProfiles.handle }).from(schema.userProfiles).where(inArray(schema.userProfiles.userId, people))).map((r) => [r.id, r.handle]),
  );
  const scored: Array<{ id: string; count: number }> = [];
  for (const id of people) {
    const rows = await metRows(db, id, season.start, now, true);
    scored.push({ id, count: progressFor({ kind: BOARD_RULE[key], target: 10_000 }, rows).count });
  }
  scored.sort((a, b) => b.count - a.count || (handles.get(a.id) ?? "").localeCompare(handles.get(b.id) ?? ""));
  const rows: BoardRow[] = scored.map((s) => {
    const rank = 1 + scored.filter((o) => o.count > s.count).length;
    return { rank, tied: scored.filter((o) => o.count === s.count).length > 1, handle: handles.get(s.id) ?? "", you: s.id === userId, count: s.count };
  });
  return { state: "ready", season: season.label, key, rows };
}

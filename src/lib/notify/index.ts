import { after } from "next/server";
import { and, desc, eq, gt, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import type { NotificationCategory, PushState } from "@/db/schema";
import { reportInBackground } from "@/lib/observability/errors";
import { isPushConfigured, sendPush } from "@/lib/push/send";
import { NOTIFICATION_GROUPS, groupFor, renderNotification, type NotificationGroupKey } from "./copy";

export { NOTIFICATION_GROUPS, renderNotification } from "./copy";

/**
 * Notifications (docs/SOCIAL.md §7.5, D18): an in-app inbox that always works,
 * plus push through `src/lib/push/send.ts` when the deployment has credentials.
 *
 * The rules, all enforced here rather than by callers:
 * - never to yourself, never across a block, never from a suspended or
 *   stepped-back account, never to somebody who has social switched off;
 * - one row per real-world event (`dedupeKey`), so toggling a cheer cannot
 *   ring a phone twice;
 * - the person's per-group switches decide whether it exists at all, the
 *   push switch and quiet hours decide only whether the phone buzzes; quiet
 *   hours suppress rather than delay (a 7 am burst is its own nudge);
 * - `notify` never throws — a failed notification must not fail the cheer.
 */

export interface NotificationSettings {
  groups: Record<NotificationGroupKey, boolean>;
  pushEnabled: boolean;
  quietStart: number | null;
  quietEnd: number | null;
  timeZone: string | null;
}

export function defaultGroups(): Record<NotificationGroupKey, boolean> {
  return Object.fromEntries(NOTIFICATION_GROUPS.map((g) => [g.key, g.defaultOn])) as Record<NotificationGroupKey, boolean>;
}

export async function getNotificationSettings(db: DB, userId: string): Promise<NotificationSettings> {
  const row = await db.query.notificationSettings.findFirst({ where: eq(schema.notificationSettings.userId, userId) });
  const groups = defaultGroups();
  for (const [k, v] of Object.entries(row?.groups ?? {})) {
    if (k in groups && typeof v === "boolean") groups[k as NotificationGroupKey] = v;
  }
  return {
    groups,
    pushEnabled: row?.pushEnabled ?? true,
    quietStart: row?.quietStart ?? null,
    quietEnd: row?.quietEnd ?? null,
    timeZone: row?.timeZone ?? null,
  };
}

const GROUP_KEYS = new Set<string>(NOTIFICATION_GROUPS.map((g) => g.key));

const minuteOfDay = z.number().int().min(0).max(1439);

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const notificationSettingsPatchSchema = z
  .object({
    groups: z
      .record(z.string(), z.boolean())
      .refine((g) => Object.keys(g).every((k) => GROUP_KEYS.has(k)), "unknown notification group")
      .optional(),
    pushEnabled: z.boolean().optional(),
    quietStart: minuteOfDay.nullable().optional(),
    quietEnd: minuteOfDay.nullable().optional(),
    timeZone: z.string().max(64).refine(validTimeZone, "unknown time zone").nullable().optional(),
  })
  .strict()
  .refine((v) => (v.quietStart === undefined) === (v.quietEnd === undefined), "quietStart and quietEnd go together");

export async function updateNotificationSettings(
  db: DB,
  userId: string,
  patch: z.infer<typeof notificationSettingsPatchSchema>,
): Promise<NotificationSettings> {
  const current = await getNotificationSettings(db, userId);
  const next = {
    groups: { ...current.groups, ...(patch.groups ?? {}) },
    pushEnabled: patch.pushEnabled ?? current.pushEnabled,
    quietStart: patch.quietStart !== undefined ? patch.quietStart : current.quietStart,
    quietEnd: patch.quietEnd !== undefined ? patch.quietEnd : current.quietEnd,
    timeZone: patch.timeZone !== undefined ? patch.timeZone : current.timeZone,
  };
  await db
    .insert(schema.notificationSettings)
    .values({ userId, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.notificationSettings.userId, set: { ...next, updatedAt: new Date() } });
  return next;
}

/** Whether `now` falls inside the person's quiet hours (which may wrap midnight). */
export function inQuietHours(s: Pick<NotificationSettings, "quietStart" | "quietEnd" | "timeZone">, now: Date): boolean {
  if (s.quietStart == null || s.quietEnd == null || s.quietStart === s.quietEnd) return false;
  let minutes: number;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: s.timeZone ?? "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    minutes = h * 60 + m;
  } catch {
    return false;
  }
  return s.quietStart < s.quietEnd
    ? minutes >= s.quietStart && minutes < s.quietEnd
    : minutes >= s.quietStart || minutes < s.quietEnd;
}

export interface NotifyInput {
  recipientId: string;
  actorId: string | null;
  category: NotificationCategory;
  subjectId?: string | null;
  data?: Record<string, string | number | boolean> | null;
  dedupeKey: string;
}

/** Socially reachable: has a profile with social on and no suspension. */
async function reachable(db: DB, userId: string): Promise<{ handle: string } | null> {
  const row = await db.query.userProfiles.findFirst({
    columns: { handle: true, socialEnabled: true, suspendedAt: true },
    where: eq(schema.userProfiles.userId, userId),
  });
  if (!row || !row.socialEnabled || row.suspendedAt != null) return null;
  return { handle: row.handle };
}

async function blockedEither(db: DB, a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.blocks.id })
    .from(schema.blocks)
    .where(
      sql`(${schema.blocks.blockerId} = ${a} and ${schema.blocks.blockedId} = ${b}) or (${schema.blocks.blockerId} = ${b} and ${schema.blocks.blockedId} = ${a})`,
    )
    .limit(1);
  return rows.length > 0;
}

/** Run after the response when inside a request; inline-but-detached otherwise (scripts, tests). */
export function deliverSoon(task: () => Promise<unknown>): void {
  const guarded = () => task().catch((err) => reportInBackground(err, { where: "notify/deliver" }));
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

/**
 * Record a notification and, when allowed, queue its push. Returns the new
 * row's id, or null when nothing was created (rules above, or a duplicate).
 */
export async function notify(db: DB, input: NotifyInput, now = new Date()): Promise<string | null> {
  try {
    if (input.actorId && input.actorId === input.recipientId) return null;
    const recipient = await reachable(db, input.recipientId);
    if (!recipient) return null;
    if (input.actorId) {
      if (!(await reachable(db, input.actorId))) return null;
      if (await blockedEither(db, input.actorId, input.recipientId)) return null;
    }
    const settings = await getNotificationSettings(db, input.recipientId);
    if (!settings.groups[groupFor(input.category).key as NotificationGroupKey]) return null;

    let pushState: PushState = "pending";
    if (!settings.pushEnabled) pushState = "none";
    else if (!isPushConfigured()) pushState = "unconfigured";
    else if (inQuietHours(settings, now)) pushState = "quiet";

    const [row] = await db
      .insert(schema.notifications)
      .values({
        id: crypto.randomUUID(),
        userId: input.recipientId,
        actorId: input.actorId,
        category: input.category,
        subjectId: input.subjectId ?? null,
        data: input.data ?? null,
        dedupeKey: input.dedupeKey,
        createdAt: now,
        pushState,
      })
      .onConflictDoNothing()
      .returning({ id: schema.notifications.id });
    if (!row) return null;
    if (pushState === "pending") deliverSoon(() => deliverNotification(db, row.id));
    return row.id;
  } catch (err) {
    reportInBackground(err, { where: "notify" });
    return null;
  }
}

/** Send one pending notification's push and record the outcome. Idempotent. */
export async function deliverNotification(db: DB, notificationId: string): Promise<PushState | null> {
  // Claim it first so a cron drain and an after() cannot both send it.
  const [claimed] = await db
    .update(schema.notifications)
    .set({ pushState: "failed" })
    .where(and(eq(schema.notifications.id, notificationId), eq(schema.notifications.pushState, "pending")))
    .returning();
  if (!claimed) return null;
  // Everything that decided "push this" is re-asked now: a drain can run
  // hours after the row was written, and a block, a switched-off group or
  // quiet hours that began since must win.
  const suppress = async (state: PushState) => {
    await db.update(schema.notifications).set({ pushState: state }).where(eq(schema.notifications.id, claimed.id));
    return state;
  };
  if (!(await reachable(db, claimed.userId))) return suppress("none");
  const actorHandle = claimed.actorId ? ((await reachable(db, claimed.actorId))?.handle ?? null) : null;
  if (claimed.actorId && (!actorHandle || (await blockedEither(db, claimed.actorId, claimed.userId)))) return suppress("none");
  const settings = await getNotificationSettings(db, claimed.userId);
  if (!settings.pushEnabled || !settings.groups[groupFor(claimed.category).key as NotificationGroupKey]) return suppress("none");
  if (inQuietHours(settings, new Date())) return suppress("quiet");
  const copy = renderNotification({
    category: claimed.category,
    actorHandle,
    subjectId: claimed.subjectId,
    data: claimed.data,
  });
  const result = await sendPush(db, claimed.userId, {
    category: claimed.category,
    title: "Whaikey",
    body: copy.text,
    deepLink: copy.deepLink,
  });
  const state: PushState = result === "unconfigured" ? "unconfigured" : result;
  await db
    .update(schema.notifications)
    .set({ pushState: state, pushedAt: result === "sent" ? new Date() : null })
    .where(eq(schema.notifications.id, claimed.id));
  return state;
}

/** Cron safety net: pushes whose after() never ran. Only the last 6 hours — older news is inbox-only. */
export async function drainPendingPushes(db: DB, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 6 * 3600_000);
  const stale = await db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.pushState, "pending"), gt(schema.notifications.createdAt, since)))
    .limit(500);
  let sent = 0;
  for (const { id } of stale) if ((await deliverNotification(db, id)) === "sent") sent++;
  // Anything older than the window stops waiting.
  await db
    .update(schema.notifications)
    .set({ pushState: "failed" })
    .where(and(eq(schema.notifications.pushState, "pending"), lt(schema.notifications.createdAt, since)));
  return sent;
}

/** Inbox retention (disclosed on /privacy): 90 days, read or not. */
export const NOTIFICATION_RETENTION_DAYS = 90;

export async function sweepNotifications(db: DB, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000);
  await db.delete(schema.notifications).where(lt(schema.notifications.createdAt, cutoff));
}

export interface InboxItem {
  id: string;
  category: NotificationCategory;
  text: string;
  deepLink: string;
  createdAt: Date;
  read: boolean;
  actor: { handle: string; displayName: string; avatarUrl: string | null } | null;
}

/**
 * The live filter every inbox read applies: the actor is still socially
 * present, not suspended and not blocked either way. A notification from
 * someone you later blocked disappears rather than lingering.
 */
function actorVisibleSql(viewerId: string) {
  return sql`(${schema.notifications.actorId} is null or (
    exists (select 1 from user_profiles ap where ap.user_id = ${schema.notifications.actorId} and ap.social_enabled = true and ap.suspended_at is null)
    and not exists (select 1 from blocks b where (b.blocker_id = ${viewerId} and b.blocked_id = ${schema.notifications.actorId}) or (b.blocker_id = ${schema.notifications.actorId} and b.blocked_id = ${viewerId}))
  )) and ${subjectVisibleSql(viewerId)}`;
}

/**
 * Notifications that describe somebody else's pour (only `friend_tasted`
 * today: its row names the bottle) stay visible only while that pour is: not
 * deleted, not private, and still readable under its own tier for this
 * viewer. The cheer/comment/reply rows are about the viewer's own note or
 * thread and carry no content of the actor's.
 */
function subjectVisibleSql(viewerId: string) {
  return sql`(${schema.notifications.category} <> 'friend_tasted' or exists (
    select 1 from pours sp where sp.id = ${schema.notifications.subjectId} and (
      (sp.visibility in ('followers', 'public') and exists (select 1 from follows f1 where f1.follower_id = ${viewerId} and f1.followee_id = sp.user_id and f1.state = 'accepted'))
      or (sp.visibility = 'friends'
        and exists (select 1 from follows f2 where f2.follower_id = ${viewerId} and f2.followee_id = sp.user_id and f2.state = 'accepted')
        and exists (select 1 from follows f3 where f3.follower_id = sp.user_id and f3.followee_id = ${viewerId} and f3.state = 'accepted'))
    )
  ))`;
}

export async function listInbox(
  db: DB,
  userId: string,
  opts: { limit?: number; before?: Date } = {},
): Promise<InboxItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const rows = await db
    .select({
      id: schema.notifications.id,
      category: schema.notifications.category,
      subjectId: schema.notifications.subjectId,
      data: schema.notifications.data,
      createdAt: schema.notifications.createdAt,
      readAt: schema.notifications.readAt,
      handle: schema.userProfiles.handle,
      displayName: schema.userProfiles.displayName,
      avatarUrl: schema.userProfiles.avatarUrl,
    })
    .from(schema.notifications)
    .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.notifications.actorId))
    .where(
      and(
        eq(schema.notifications.userId, userId),
        actorVisibleSql(userId),
        opts.before ? lt(schema.notifications.createdAt, opts.before) : undefined,
      ),
    )
    .orderBy(desc(schema.notifications.createdAt), desc(schema.notifications.id))
    .limit(limit);
  return rows.map((r) => {
    const copy = renderNotification({ category: r.category, actorHandle: r.handle, subjectId: r.subjectId, data: r.data });
    return {
      id: r.id,
      category: r.category,
      text: copy.text,
      deepLink: copy.deepLink,
      createdAt: r.createdAt,
      read: r.readAt != null,
      actor: r.handle ? { handle: r.handle, displayName: r.displayName ?? "", avatarUrl: r.avatarUrl } : null,
    };
  });
}

export async function unreadCount(db: DB, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt), actorVisibleSql(userId)));
  return Number(row?.n ?? 0);
}

/** Mark the given ids (or everything) read. Only ever the caller's own rows. */
export async function markRead(db: DB, userId: string, ids?: string[], now = new Date()): Promise<number> {
  const rows = await db
    .update(schema.notifications)
    .set({ readAt: now })
    .where(
      and(
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.readAt),
        ids ? inArray(schema.notifications.id, ids.length > 0 ? ids : ["__none__"]) : undefined,
      ),
    )
    .returning({ id: schema.notifications.id });
  return rows.length;
}

/**
 * "A friend shared a note on a bottle you own or wishlisted" — batched, at most
 * one per person per UTC day (D18). Run once a day by the cron sweep.
 *
 * Only friends the recipient follows (accepted), only notes the recipient can
 * already see under the pour's own visibility, and never more than the one
 * most recent note — the point is "something to talk about", not a tally.
 */
export async function friendTastedDigest(db: DB, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 3600_000);
  const day = now.toISOString().slice(0, 10);
  const ub = schema.userBottles;
  const p = schema.pours;
  const candidates = await db
    .select({
      recipientId: ub.userId,
      authorId: p.userId,
      pourId: p.id,
      bottleName: schema.bottles.name,
      relationship: ub.relationship,
    })
    .from(p)
    .innerJoin(schema.bottles, eq(schema.bottles.id, p.bottleId))
    .innerJoin(ub, and(eq(ub.bottleId, p.bottleId), inArray(ub.relationship, ["own", "wishlist"]), ne(ub.userId, p.userId)))
    .where(
      and(
        gt(p.createdAt, since),
        lte(p.createdAt, now),
        ne(p.visibility, "private"),
        sql`exists (select 1 from follows f where f.follower_id = ${ub.userId} and f.followee_id = ${p.userId} and f.state = 'accepted')`,
        sql`(${p.rating} is not null or exists (select 1 from tasting_notes tn where tn.pour_id = ${p.id}))`,
      ),
    )
    .orderBy(desc(p.createdAt));
  const done = new Set<string>();
  const { canViewPour } = await import("@/lib/social");
  let created = 0;
  for (const r of candidates) {
    if (done.has(r.recipientId)) continue;
    if (!(await canViewPour(db, r.recipientId, r.pourId))) continue;
    done.add(r.recipientId);
    const id = await notify(
      db,
      {
        recipientId: r.recipientId,
        actorId: r.authorId,
        category: "friend_tasted",
        subjectId: r.pourId,
        data: { pourId: r.pourId, bottleName: r.bottleName, relationship: r.relationship },
        dedupeKey: `friend_tasted:${day}`,
      },
      now,
    );
    if (id) created++;
  }
  return created;
}

/** Group keys whose categories a caller may target — re-exported for routes/UI. */
export type { NotificationGroupKey };
export const NOTIFICATION_CATEGORY_LIST = schema.NOTIFICATION_CATEGORIES;

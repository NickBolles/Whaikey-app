import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";

/**
 * Replies and reactions on an outing (owner request 2026-10-29): on a bottle
 * on the shared list, or on one person's rating of it. Only people on the
 * outing see them, under the same block / suspension / expired-guest filter as
 * the board (the caller passes the visible participant ids). No push: they
 * show up live on the outing page and nowhere else.
 */

/**
 * The fixed reaction set — the one place to tweak it (owner, 2026-10-29).
 * Every reaction is about the tasting or each other, never about drinking
 * more. Shown as compact chips: a small typographic glyph plus the label.
 * `hint` is the longer meaning for tooltips and screen readers. Removing an
 * id hides stored reactions of that kind; it never breaks reads.
 */
export const OUTING_REACTIONS = [
  { id: "agree", label: "Agree", glyph: "✓", hint: "Agree" },
  { id: "same_here", label: "Same here", glyph: "≈", hint: "Same here: I tasted that too" },
  { id: "surprised", label: "Surprised", glyph: "!", hint: "Surprised" },
  { id: "want_to_try", label: "Want to try", glyph: "+", hint: "Want to try" },
  { id: "great_note", label: "Great note", glyph: "✎", hint: "Great note" },
  { id: "learned", label: "Learned something", glyph: "↗", hint: "Learned something" },
  { id: "not_for_me", label: "Not for me", glyph: "–", hint: "Not for me" },
  { id: "brave_pick", label: "Brave pick", glyph: "◆", hint: "Brave pick" },
] as const;
export type OutingReactionKind = (typeof OUTING_REACTIONS)[number]["id"];
const REACTION_IDS = OUTING_REACTIONS.map((r) => r.id) as [OutingReactionKind, ...OutingReactionKind[]];

export const OUTING_COMMENT_MAX = 280;
/** Per person per outing, like every other cross-user free-text surface on a guest-joinable object. */
export const OUTING_COMMENT_CAP = 60;

const target = {
  targetKind: z.enum(["bottle", "tasting"]),
  targetId: z.string().trim().min(1).max(200),
};
export const outingCommentSchema = z.object({ ...target, body: z.string().trim().min(1).max(OUTING_COMMENT_MAX) }).strict();
export const outingCommentEditSchema = z.object({ body: z.string().trim().min(1).max(OUTING_COMMENT_MAX) }).strict();
export const outingReactionSchema = z.object({ ...target, kind: z.enum(REACTION_IDS), on: z.boolean() }).strict();

export type OutingTargetKind = "bottle" | "tasting";
export const targetRef = (kind: OutingTargetKind, id: string) => `${kind}:${id}`;

export interface OutingMember {
  participantId: string;
  /** Display name as the board shows it. */
  name: string;
  handle: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]/g, "");

/**
 * Pure: which people on the outing an @mention names. Matches a handle
 * (`@sam_k`) or a display name's first word (`@Sam`), case-insensitively,
 * only among the visible members, never the author.
 */
export function parseMentions(body: string, members: OutingMember[], authorParticipantId: string | null): string[] {
  const words = [...body.matchAll(/@([\p{L}\p{N}_.-]{2,40})/gu)].map((m) => norm(m[1]));
  if (!words.length) return [];
  const out = new Set<string>();
  for (const w of words) {
    for (const m of members) {
      if (m.participantId === authorParticipantId) continue;
      const first = norm(m.name.split(/\s+/)[0] ?? "");
      if ((m.handle && norm(m.handle) === w) || (first && first === w)) out.add(m.participantId);
    }
  }
  return [...out];
}

/** Does the target exist on this outing, and is it something the caller can see? */
async function targetExists(db: DB, outingId: string, kind: OutingTargetKind, id: string, visible: Set<string>) {
  if (kind === "tasting") {
    const t = await db.query.outingTastings.findFirst({
      columns: { participantId: true, hiddenAt: true },
      where: and(eq(schema.outingTastings.id, id), eq(schema.outingTastings.outingId, outingId)),
    });
    return !!t && t.hiddenAt == null && visible.has(t.participantId);
  }
  // A bottle is addressed by its board key: a list entry's dedupe key, or the
  // key of a bottle known only from a tasting.
  const entry = await db.query.outingBottles.findFirst({
    columns: { hiddenAt: true, participantId: true },
    where: and(eq(schema.outingBottles.outingId, outingId), eq(schema.outingBottles.dedupeKey, id)),
  });
  // A hidden or not-visible entry can still be on the board via a visible
  // tasting, so fall through to the tastings rather than rejecting.
  if (entry && entry.hiddenAt == null && visible.has(entry.participantId)) return true;
  const rows = await db
    .select({ bottleId: schema.outingTastings.bottleId, label: schema.outingTastings.label, participantId: schema.outingTastings.participantId })
    .from(schema.outingTastings)
    .where(and(eq(schema.outingTastings.outingId, outingId), sql`${schema.outingTastings.hiddenAt} is null`));
  return rows.some((r) => visible.has(r.participantId) && (r.bottleId ? `b:${r.bottleId}` : `l:${r.label.toLowerCase().replace(/\s+/g, " ").trim()}`) === id);
}

export type CommentResult = { id: string } | { error: "not_open" | "not_found" | "too_many" };

export async function addOutingComment(
  db: DB,
  outing: schema.Outing,
  participantId: string,
  input: z.infer<typeof outingCommentSchema>,
  members: OutingMember[],
): Promise<CommentResult> {
  if (outing.state !== "open") return { error: "not_open" };
  const visible = new Set(members.map((m) => m.participantId));
  if (!(await targetExists(db, outing.id, input.targetKind, input.targetId, visible))) return { error: "not_found" };
  const [n] = await db.select({ n: sql<number>`count(*)` }).from(schema.outingComments).where(eq(schema.outingComments.participantId, participantId));
  if (Number(n?.n ?? 0) >= OUTING_COMMENT_CAP) return { error: "too_many" };
  const [row] = await db
    .insert(schema.outingComments)
    .values({
      id: crypto.randomUUID(),
      outingId: outing.id,
      participantId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      body: input.body,
      mentions: parseMentions(input.body, members, participantId),
    })
    .returning({ id: schema.outingComments.id });
  return { id: row.id };
}

/** Edit your own reply while the outing is open. */
export async function editOutingComment(db: DB, outing: schema.Outing, participantId: string, id: string, body: string, members: OutingMember[]) {
  if (outing.state !== "open") return false;
  const rows = await db
    .update(schema.outingComments)
    .set({ body, mentions: parseMentions(body, members, participantId), editedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.outingComments.id, id), eq(schema.outingComments.outingId, outing.id), eq(schema.outingComments.participantId, participantId)))
    .returning({ id: schema.outingComments.id });
  return rows.length > 0;
}

/** Delete your own reply (any time), or hide anyone's as the host. */
export async function removeOutingComment(db: DB, outing: schema.Outing, participantId: string | null, isHost: boolean, id: string) {
  const own = participantId
    ? await db
        .delete(schema.outingComments)
        .where(and(eq(schema.outingComments.id, id), eq(schema.outingComments.outingId, outing.id), eq(schema.outingComments.participantId, participantId)))
        .returning({ id: schema.outingComments.id })
    : [];
  if (own.length) return "deleted" as const;
  if (!isHost) return null;
  const hid = await db
    .update(schema.outingComments)
    .set({ hiddenAt: new Date() })
    .where(and(eq(schema.outingComments.id, id), eq(schema.outingComments.outingId, outing.id)))
    .returning({ id: schema.outingComments.id });
  return hid.length ? ("hidden" as const) : null;
}

/** Set or clear one reaction. Idempotent both ways. */
export async function setOutingReaction(db: DB, outing: schema.Outing, participantId: string, input: z.infer<typeof outingReactionSchema>, members: OutingMember[]) {
  if (outing.state !== "open") return { error: "not_open" as const };
  const visible = new Set(members.map((m) => m.participantId));
  if (!(await targetExists(db, outing.id, input.targetKind, input.targetId, visible))) return { error: "not_found" as const };
  // No reacting to your own tasting: appreciation has to come from others.
  if (input.targetKind === "tasting") {
    const own = await db.query.outingTastings.findFirst({
      columns: { participantId: true },
      where: and(eq(schema.outingTastings.id, input.targetId), eq(schema.outingTastings.outingId, outing.id)),
    });
    if (own?.participantId === participantId) return { error: "not_found" as const };
  }
  const where = and(
    eq(schema.outingReactions.participantId, participantId),
    eq(schema.outingReactions.targetKind, input.targetKind),
    eq(schema.outingReactions.targetId, input.targetId),
    eq(schema.outingReactions.kind, input.kind),
  );
  if (input.on) {
    await db
      .insert(schema.outingReactions)
      .values({ id: crypto.randomUUID(), outingId: outing.id, participantId, targetKind: input.targetKind, targetId: input.targetId, kind: input.kind })
      .onConflictDoNothing();
  } else {
    await db.delete(schema.outingReactions).where(where);
  }
  return { on: input.on };
}

export interface OutingCommentView {
  id: string;
  who: string;
  mine: boolean;
  body: string;
  edited: boolean;
  /** Names the viewer can see; mentions of anyone hidden from them are dropped. */
  mentions: string[];
  mentionsMe: boolean;
  createdAt: Date;
}
export interface OutingReactionView {
  kind: OutingReactionKind;
  label: string;
  glyph: string;
  /** How many people reacted this way (people, never amounts). */
  count: number;
  /** People who reacted, as the viewer sees them (names, not a leaderboard). */
  who: string[];
  mine: boolean;
}
export interface OutingSocial {
  comments: Record<string, OutingCommentView[]>;
  reactions: Record<string, OutingReactionView[]>;
}

interface CommentRow {
  id: string;
  participantId: string;
  targetKind: string;
  targetId: string;
  body: string;
  mentions: string[] | null;
  editedAt: Date | null;
  hiddenAt: Date | null;
  createdAt: Date;
}
interface ReactionRow {
  participantId: string;
  targetKind: string;
  targetId: string;
  kind: string;
}

/**
 * Pure: replies and reactions grouped by target for one viewer. Anything by a
 * person the viewer can't see (blocked either way, suspended, expired guest)
 * is dropped, as are host-hidden replies.
 */
export function buildOutingSocial(
  comments: CommentRow[],
  reactions: ReactionRow[],
  members: OutingMember[],
  viewerParticipantId: string | null,
  liveTargets?: Set<string>,
): OutingSocial {
  const names = new Map(members.map((m) => [m.participantId, m.participantId === viewerParticipantId ? "You" : m.name]));
  const out: OutingSocial = { comments: {}, reactions: {} };
  for (const c of [...comments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (c.hiddenAt != null || !names.has(c.participantId)) continue;
    const ref = targetRef(c.targetKind as OutingTargetKind, c.targetId);
    if (liveTargets && !liveTargets.has(ref)) continue;
    (out.comments[ref] ??= []).push({
      id: c.id,
      who: names.get(c.participantId)!,
      mine: c.participantId === viewerParticipantId,
      body: c.body,
      edited: c.editedAt != null,
      mentions: (c.mentions ?? []).filter((p) => names.has(p)).map((p) => names.get(p)!),
      mentionsMe: !!viewerParticipantId && (c.mentions ?? []).includes(viewerParticipantId),
      createdAt: c.createdAt,
    });
  }
  const grouped = new Map<string, Map<string, string[]>>();
  for (const r of reactions) {
    if (!names.has(r.participantId) || !REACTION_IDS.includes(r.kind as OutingReactionKind)) continue;
    const ref = targetRef(r.targetKind as OutingTargetKind, r.targetId);
    if (liveTargets && !liveTargets.has(ref)) continue;
    const byKind = grouped.get(ref) ?? new Map<string, string[]>();
    grouped.set(ref, byKind);
    byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.participantId]);
  }
  for (const [ref, byKind] of grouped) {
    out.reactions[ref] = OUTING_REACTIONS.filter((k) => byKind.has(k.id)).map((k) => {
      const ids = byKind.get(k.id)!;
      return { kind: k.id, label: k.label, glyph: k.glyph, count: ids.length, who: ids.map((p) => names.get(p)!), mine: !!viewerParticipantId && ids.includes(viewerParticipantId) };
    });
  }
  return out;
}

/** Load replies and reactions for an outing and shape them for one viewer. */
export async function loadOutingSocial(db: DB, outingId: string, members: OutingMember[], viewerParticipantId: string | null, liveTargets?: Set<string>) {
  const ids = members.map((m) => m.participantId);
  if (!ids.length) return { comments: {}, reactions: {} } satisfies OutingSocial;
  const comments = await db
    .select()
    .from(schema.outingComments)
    .where(and(eq(schema.outingComments.outingId, outingId), inArray(schema.outingComments.participantId, ids)))
    .orderBy(asc(schema.outingComments.createdAt));
  const reactions = await db
    .select()
    .from(schema.outingReactions)
    .where(and(eq(schema.outingReactions.outingId, outingId), inArray(schema.outingReactions.participantId, ids)));
  return buildOutingSocial(comments, reactions, members, viewerParticipantId, liveTargets);
}

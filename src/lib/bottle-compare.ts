/**
 * The three-source comparison behind /bottles/[id]/compare: the viewer's own
 * note on a bottle read against three DISTINCT reference sets — friends (only
 * people you follow), community (opt-in public pours, anonymised into an
 * aggregate), and professional (the producer's attributed note plus any
 * critic notes on file). They are deliberately never collapsed into one
 * "community" number: each source gets its own agreement bars and its own
 * match percentage. None of them is an answer key.
 */

import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import { hasPublishedProducerFlavorNotes } from "@/lib/bar";
import { isValidLeaf } from "@/lib/flavor-wheel";
import { getFriendNotesForBottle } from "@/lib/social";

export type CompareSource = "friends" | "community" | "professional";

export interface AgreementRow {
  leafId: string;
  /** The viewer's intensity (0 when only the reference logged it — that absence is the point). */
  mine: number;
  /** The reference's intensity (possibly fractional: community means are averages). */
  theirs: number;
}

function validTags(tags: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [leafId, intensity] of Object.entries(tags ?? {})) {
    if (isValidLeaf(leafId) && typeof intensity === "number" && intensity > 0) {
      out[leafId] = intensity;
    }
  }
  return out;
}

/**
 * Matched intensity over total intensity across the union of both flavor
 * sets (weighted Jaccard), as a whole percent. Null when there is nothing on
 * either side to compare.
 */
export function matchPercent(
  mine: Record<string, number> | null | undefined,
  theirs: Record<string, number> | null | undefined,
): number | null {
  const a = validTags(mine);
  const b = validTags(theirs);
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  let matched = 0;
  let total = 0;
  for (const id of ids) {
    matched += Math.min(a[id] ?? 0, b[id] ?? 0);
    total += Math.max(a[id] ?? 0, b[id] ?? 0);
  }
  if (total === 0) return null;
  return Math.round((matched / total) * 100);
}

/**
 * One row per flavor across the union of both sets, combined intensity
 * descending, capped. Flavors only the reference logged stay in — a zero-width
 * "you" bar is the screen's whole message.
 */
export function agreementRows(
  mine: Record<string, number> | null | undefined,
  theirs: Record<string, number> | null | undefined,
  limit = 6,
): AgreementRow[] {
  const a = validTags(mine);
  const b = validTags(theirs);
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ids]
    .map((leafId) => ({ leafId, mine: a[leafId] ?? 0, theirs: b[leafId] ?? 0 }))
    .sort(
      (x, y) =>
        y.mine + y.theirs - (x.mine + x.theirs) ||
        y.theirs - x.theirs ||
        x.leafId.localeCompare(y.leafId),
    )
    .slice(0, limit);
}

/** Mean intensity per leaf across contributors who named it, 1 decimal. */
export function meanTags(records: Array<Record<string, number> | null | undefined>): Record<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const record of records) {
    for (const [leafId, intensity] of Object.entries(validTags(record))) {
      const cur = sums.get(leafId) ?? { total: 0, count: 0 };
      cur.total += intensity;
      cur.count += 1;
      sums.set(leafId, cur);
    }
  }
  const out: Record<string, number> = {};
  for (const [leafId, { total, count }] of sums) {
    out[leafId] = Math.round((total / count) * 10) / 10;
  }
  return out;
}

export interface CompareProseAuthor {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CompareProseNote {
  pourId: string;
  author: CompareProseAuthor;
  rating: number | null;
  createdAt: string;
  text: string | null;
  flavorTags: Record<string, number> | null;
}

export interface CriticNoteView {
  publication: string;
  score: string | null;
  scoreScale: string | null;
  note: string;
  sourceUrl: string;
  flavorTags: Record<string, number> | null;
}

export interface BottleComparison {
  bottleId: string;
  bottleName: string;
  viewerTags: Record<string, number>;
  /** The viewer's latest pour of this bottle — where a tapped "+" chip lands. */
  viewerPourId: string | null;
  friends: { count: number; tags: Record<string, number>; notes: CompareProseNote[] };
  community: { count: number; tags: Record<string, number>; notes: CompareProseNote[] };
  professional: {
    tags: Record<string, number>;
    producer: {
      sourceLabel: string;
      sourceUrl: string;
      text: string | null;
      tags: Record<string, number>;
    } | null;
    critics: CriticNoteView[];
  };
}

/** A friend's sections joined into one compact paragraph for the card. */
function proseText(parts: Array<string | null | undefined>): string | null {
  const text = parts
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" ");
  return text || null;
}

export async function getBottleComparison(
  db: DB,
  viewerId: string,
  bottleId: string,
): Promise<BottleComparison | null> {
  const bottle = await db.query.bottles.findFirst({ where: eq(schema.bottles.id, bottleId) });
  if (!bottle) return null;

  // --- The viewer's own note: union max across every pour of this bottle. ---
  const viewerRows = await db
    .select({
      pourId: schema.pours.id,
      createdAt: schema.pours.createdAt,
      flavorTags: schema.tastingNotes.flavorTags,
    })
    .from(schema.pours)
    .leftJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(and(eq(schema.pours.userId, viewerId), eq(schema.pours.bottleId, bottleId)))
    .orderBy(desc(schema.pours.createdAt));

  const viewerTags: Record<string, number> = {};
  for (const row of viewerRows) {
    for (const [leafId, intensity] of Object.entries(validTags(row.flavorTags))) {
      viewerTags[leafId] = Math.max(viewerTags[leafId] ?? 0, intensity);
    }
  }
  const viewerPourId = viewerRows[0]?.pourId ?? null;

  // --- Friends: people you follow who logged this bottle. ---
  const friendNotes = await getFriendNotesForBottle(db, viewerId, bottleId);
  const friends = {
    count: friendNotes.length,
    tags: meanTags(friendNotes.map((f) => f.flavorTags)),
    notes: friendNotes.map((f) => ({
      pourId: f.pourId,
      author: {
        handle: f.author.handle,
        displayName: f.author.displayName,
        avatarUrl: f.author.avatarUrl,
      },
      rating: f.rating,
      createdAt: f.createdAt.toISOString(),
      text: proseText([f.nose, f.palate, f.finish, f.freeform]),
      flavorTags: f.flavorTags,
    })),
  };

  // --- Community: opt-in (public-visibility) pours, viewer's own excluded. ---
  // docs/SOCIAL.md D6: aggregates are built only from what people chose to
  // publish, and the aggregate itself carries no attribution; the prose cards
  // below are attributed because a public note is already a social surface.
  const blockedRows = await db
    .select({ blockerId: schema.blocks.blockerId, blockedId: schema.blocks.blockedId })
    .from(schema.blocks)
    .where(or(eq(schema.blocks.blockerId, viewerId), eq(schema.blocks.blockedId, viewerId)));
  const blocked = new Set(
    blockedRows.map((r) => (r.blockerId === viewerId ? r.blockedId : r.blockerId)),
  );

  const communityRows = await db
    .select({
      pourId: schema.pours.id,
      userId: schema.pours.userId,
      rating: schema.pours.rating,
      createdAt: schema.pours.createdAt,
      flavorTags: schema.tastingNotes.flavorTags,
      nose: schema.tastingNotes.nose,
      palate: schema.tastingNotes.palate,
      finish: schema.tastingNotes.finish,
      freeform: schema.tastingNotes.freeform,
      handle: schema.userProfiles.handle,
      displayName: schema.userProfiles.displayName,
      avatarUrl: schema.userProfiles.avatarUrl,
    })
    .from(schema.pours)
    .innerJoin(
      schema.tastingNotes,
      and(
        eq(schema.tastingNotes.pourId, schema.pours.id),
        sql`${schema.tastingNotes.flavorTags} is not null and ${schema.tastingNotes.flavorTags} <> '{}'::jsonb`,
      ),
    )
    .innerJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.pours.userId))
    .where(
      and(
        eq(schema.pours.bottleId, bottleId),
        eq(schema.pours.visibility, "public"),
        ne(schema.pours.userId, viewerId),
        eq(schema.userProfiles.socialEnabled, true),
      ),
    )
    .orderBy(desc(schema.pours.createdAt));
  const visibleCommunity = communityRows.filter((r) => !blocked.has(r.userId));

  const communityProse = [...visibleCommunity]
    .filter((r) => proseText([r.nose, r.palate, r.finish, r.freeform]) != null)
    .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || +b.createdAt - +a.createdAt)
    .slice(0, 3);

  const community = {
    count: visibleCommunity.length,
    tags: meanTags(visibleCommunity.map((r) => r.flavorTags)),
    notes: communityProse.map((r) => ({
      pourId: r.pourId,
      author: { handle: r.handle, displayName: r.displayName, avatarUrl: r.avatarUrl },
      rating: r.rating,
      createdAt: r.createdAt.toISOString(),
      text: proseText([r.nose, r.palate, r.finish, r.freeform]),
      flavorTags: r.flavorTags,
    })),
  };

  // --- Professional: the producer's attributed note plus critics on file. ---
  const producer =
    hasPublishedProducerFlavorNotes(bottle) && bottle.producerFlavorTags
      ? {
          sourceLabel: bottle.producerFlavorSourceLabel as string,
          sourceUrl: bottle.producerFlavorSourceUrl as string,
          text: bottle.description,
          tags: validTags(bottle.producerFlavorTags),
        }
      : null;

  const criticRows = await db
    .select()
    .from(schema.criticNotes)
    .where(eq(schema.criticNotes.bottleId, bottleId))
    .orderBy(desc(schema.criticNotes.createdAt));

  // The producer is the fixed reference; critics supplement. Merge by max so a
  // flavor either names counts at full strength.
  const professionalTags: Record<string, number> = { ...(producer?.tags ?? {}) };
  for (const critic of criticRows) {
    for (const [leafId, intensity] of Object.entries(validTags(critic.flavorTags))) {
      professionalTags[leafId] = Math.max(professionalTags[leafId] ?? 0, intensity);
    }
  }

  return {
    bottleId,
    bottleName: bottle.name,
    viewerTags,
    viewerPourId,
    friends,
    community,
    professional: {
      tags: professionalTags,
      producer,
      critics: criticRows.map((c) => ({
        publication: c.publication,
        score: c.score,
        scoreScale: c.scoreScale,
        note: c.note,
        sourceUrl: c.sourceUrl,
        flavorTags: c.flavorTags,
      })),
    },
  };
}

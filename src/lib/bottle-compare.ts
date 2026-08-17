/**
 * The three-source comparison behind /bottles/[id]/compare: the viewer's own
 * note on a bottle read against three DISTINCT reference sets — friends (only
 * people you follow), community (opt-in public pours, anonymised into an
 * aggregate), and professional (the producer's attributed note plus any
 * critic notes on file). They are deliberately never collapsed into one
 * "community" number: each source gets its own agreement bars and its own
 * match percentage. None of them is an answer key.
 *
 * Pure math and view types live in src/lib/compare-math.ts so the client
 * segment switcher can recompute without dragging the DB into the bundle.
 */

import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import { hasPublishedProducerFlavorNotes } from "@/lib/bar";
import { getFriendNotesForBottle } from "@/lib/social";
import { meanTags, validTags, type BottleComparison } from "@/lib/compare-math";

export * from "@/lib/compare-math";

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

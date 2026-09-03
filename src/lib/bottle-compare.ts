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

import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import { hasPublishedProducerFlavorNotes } from "@/lib/bar";
import { contributorVisibleSql, getFriendNotesForBottle } from "@/lib/social";
import { meanTags, validTags, type BottleComparison } from "@/lib/compare-math";
import { MIN_COMMUNITY_RATERS } from "@/lib/search";

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

  // --- Community: an ANONYMOUS aggregate over opt-in (public) pours. ---
  //
  // Deliberately tags-only: no identity, no prose, nothing selected that could
  // become either. Public *discovery* — strangers' notes reaching a viewer who
  // does not follow them — is deferred to S4 behind the jurisdiction review
  // (docs/SOCIAL.md §11, §13 roadmap, Q2), so this segment stays at the
  // aggregate level D6 already allows: built only from what people chose to
  // publish, and anonymised at read time.
  //
  // The block check is a live predicate rather than a snapshot read followed
  // by a filter: a block created between the two would leave the stale set
  // admitting the newly blocked user's tags. Same predicate every other
  // social read path uses, so blocking stays immediate.
  const communityRows = await db
    .select({ flavorTags: schema.tastingNotes.flavorTags, userId: schema.pours.userId })
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
        contributorVisibleSql(schema.pours.userId, viewerId),
      ),
    );

  // The same anonymity floor as the bottle page's community rating, and for
  // the same reason (review SEC-M2, docs/SOCIAL.md §8): with one contributor,
  // an "aggregate" is one stranger's exact tag profile, and the count says so.
  // Counted per person, not per pour — three notes from one enthusiast are one
  // palate, and a per-row floor would let them clear it alone.
  const communityContributors = new Set(communityRows.map((r) => r.userId)).size;
  const community =
    communityContributors >= MIN_COMMUNITY_RATERS
      ? { count: communityRows.length, tags: meanTags(communityRows.map((r) => r.flavorTags)) }
      : { count: 0, tags: {} };

  // --- Professional: the producer's attributed note plus critics on file. ---
  //
  // Tags only, no prose: `bottles.description` is Whaikey's own editorial
  // catalog copy, written independently of `producerFlavorSourceUrl`, so
  // rendering it under the DISTILLERY badge beside that link would attribute
  // our words to the producer. Sourced producer prose needs its own attributed
  // column before it can appear here.
  const producer =
    hasPublishedProducerFlavorNotes(bottle) && bottle.producerFlavorTags
      ? {
          sourceLabel: bottle.producerFlavorSourceLabel as string,
          sourceUrl: bottle.producerFlavorSourceUrl as string,
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

/**
 * Taste twins (docs/SOCIAL.md US-16): how closely another drinker's palate
 * matches your own, and what that lets a recommendation say out loud.
 *
 * Two rules shape everything here.
 *
 * **Scope.** A match is only ever computed against people the viewer has an
 * accepted follow on. That is strictly inside what the viewer can already
 * see — `getProfileView` shows a followee's palate card on the same
 * condition — and it keeps taste twins clear of S4 public discovery, which
 * waits on the jurisdiction review (§11, Q2). Strangers never become a
 * "twin", however similar their palate.
 *
 * **Evidence.** A palate built from one pour will happily report 96% against
 * anyone; the number would be noise wearing a percentage sign. Both sides
 * need at least MIN_TWIN_SAMPLE rated pours behind them or the match is null
 * and the surface hides it, the same way `tasteMatchPercent` hides a
 * bottle match before the palate has signal.
 *
 * Nothing here counts or ranks pour volume: a twin is someone who tastes like
 * you, never someone who drinks more than you.
 */

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import { cosineSimilarity, type PalateVector } from "@/lib/palate";
import { getUserPalate } from "@/lib/palate-store";
import { contributorVisibleSql } from "@/lib/social";

/**
 * Rated pours each side needs before a match is reported. Three is the same
 * floor the Home dashboard uses to decide it has enough to describe a month.
 */
export const MIN_TWIN_SAMPLE = 3;

/** A twin's rating has to be at least this to count as an endorsement. */
export const ENDORSEMENT_RATING = 4;

export interface TasteTwin {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** 0-100; opposite palates clamp to 0 rather than going negative. */
  matchPercent: number;
}

/**
 * Palate-to-palate match, 0-100. Null when either palate is too thin to mean
 * anything. Palate vectors are signed (a disliked family is negative), so a
 * negative cosine is a genuinely opposite palate — reported as 0 rather than
 * as a negative percentage, which no surface could render honestly.
 */
export function palateMatchPercent(
  a: PalateVector,
  aSampleSize: number,
  b: PalateVector,
  bSampleSize: number,
): number | null {
  if (aSampleSize < MIN_TWIN_SAMPLE || bSampleSize < MIN_TWIN_SAMPLE) return null;
  const sim = cosineSimilarity(a, b);
  if (sim <= 0) return 0;
  return Math.round(sim * 100);
}

/** Accepted followees of the viewer who are visible to them right now. */
async function visibleFolloweeIds(db: DB, viewerId: string): Promise<string[]> {
  const rows = await db
    .select({ followeeId: schema.follows.followeeId })
    .from(schema.follows)
    .where(
      and(
        eq(schema.follows.followerId, viewerId),
        eq(schema.follows.state, "accepted"),
        contributorVisibleSql(schema.follows.followeeId, viewerId),
      ),
    );
  return rows.map((r) => r.followeeId);
}

/**
 * The match between the viewer and one other person, for that person's
 * profile. Null for the viewer themself (a 100% match with yourself is not a
 * fact worth a chip), for anyone they don't follow, and whenever either
 * palate is too thin.
 */
export async function getPalateMatch(
  db: DB,
  viewerId: string | null,
  otherUserId: string,
): Promise<number | null> {
  if (!viewerId || viewerId === otherUserId) return null;
  const followees = await visibleFolloweeIds(db, viewerId);
  if (!followees.includes(otherUserId)) return null;

  const [mine, theirs] = await Promise.all([
    getUserPalate(db, viewerId),
    getUserPalate(db, otherUserId),
  ]);
  return palateMatchPercent(mine.vector, mine.sampleSize, theirs.vector, theirs.sampleSize);
}

/**
 * The viewer's closest palates among the people they follow, strongest first.
 * Anyone whose match cannot be computed is left out rather than shown at 0 —
 * "we don't know yet" and "you taste nothing alike" are different claims.
 */
export async function getTasteTwins(db: DB, viewerId: string, limit = 5): Promise<TasteTwin[]> {
  const followeeIds = await visibleFolloweeIds(db, viewerId);
  if (followeeIds.length === 0) return [];

  const mine = await getUserPalate(db, viewerId);
  if (mine.sampleSize < MIN_TWIN_SAMPLE) return [];

  const profiles = await db
    .select({
      userId: schema.userProfiles.userId,
      handle: schema.userProfiles.handle,
      displayName: schema.userProfiles.displayName,
      avatarUrl: schema.userProfiles.avatarUrl,
    })
    .from(schema.userProfiles)
    .where(
      and(
        inArray(schema.userProfiles.userId, followeeIds),
        eq(schema.userProfiles.socialEnabled, true),
      ),
    );

  const twins: TasteTwin[] = [];
  for (const profile of profiles) {
    const theirs = await getUserPalate(db, profile.userId);
    const matchPercent = palateMatchPercent(
      mine.vector,
      mine.sampleSize,
      theirs.vector,
      theirs.sampleSize,
    );
    if (matchPercent == null) continue;
    twins.push({ ...profile, matchPercent });
  }

  return twins
    .sort((a, b) => b.matchPercent - a.matchPercent || a.handle.localeCompare(b.handle))
    .slice(0, limit);
}

export interface TwinEndorsement {
  bottleId: string;
  /** How many twins rated it at or above ENDORSEMENT_RATING. */
  twinCount: number;
  /** The closest-matching endorser, for the reason line. */
  topTwin: TasteTwin;
  /** Highest rating among the endorsing twins. */
  topRating: number;
}

/**
 * Which of the given bottles the viewer's taste twins rated highly — the
 * evidence behind "your closest palate match rated it 4.5".
 *
 * Visibility is enforced exactly as `getFriendNotesForBottle` enforces it: a
 * pour reaches the viewer only when it is followers/public, or friends-only
 * from someone who follows them back. A twin's private pour must not leak its
 * rating into a recommendation reason — the reason is a social projection of
 * that pour, and it stays behind the same gate the note itself does.
 */
export async function getTwinEndorsements(
  db: DB,
  viewerId: string,
  bottleIds: string[],
  twins: TasteTwin[],
): Promise<Map<string, TwinEndorsement>> {
  const out = new Map<string, TwinEndorsement>();
  if (bottleIds.length === 0 || twins.length === 0) return out;

  const twinById = new Map(twins.map((t) => [t.userId, t]));
  const twinIds = [...twinById.keys()];

  const followsBackRows = await db
    .select({ followerId: schema.follows.followerId })
    .from(schema.follows)
    .where(
      and(
        inArray(schema.follows.followerId, twinIds),
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
      bottleId: schema.pours.bottleId,
      userId: schema.pours.userId,
      rating: schema.pours.rating,
    })
    .from(schema.pours)
    .where(
      and(
        inArray(schema.pours.bottleId, bottleIds),
        inArray(schema.pours.userId, twinIds),
        sql`${schema.pours.rating} >= ${ENDORSEMENT_RATING}`,
        contributorVisibleSql(schema.pours.userId, viewerId),
        visibilityCond,
      ),
    )
    .orderBy(desc(schema.pours.rating));

  // One entry per bottle, crediting the closest-matching endorser; the count
  // is distinct people, so a twin who poured it twice is still one voice.
  const seenPerBottle = new Map<string, Set<string>>();
  for (const row of rows) {
    const twin = twinById.get(row.userId);
    if (!twin || row.rating == null) continue;

    const seen = seenPerBottle.get(row.bottleId) ?? new Set<string>();
    const isNewVoice = !seen.has(row.userId);
    seen.add(row.userId);
    seenPerBottle.set(row.bottleId, seen);

    const existing = out.get(row.bottleId);
    if (!existing) {
      out.set(row.bottleId, {
        bottleId: row.bottleId,
        twinCount: 1,
        topTwin: twin,
        topRating: row.rating,
      });
      continue;
    }
    if (isNewVoice) existing.twinCount += 1;
    if (row.rating > existing.topRating) existing.topRating = row.rating;
    if (twin.matchPercent > existing.topTwin.matchPercent) existing.topTwin = twin;
  }

  return out;
}

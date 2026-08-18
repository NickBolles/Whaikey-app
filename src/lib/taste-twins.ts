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
 * need at least MIN_TWIN_SAMPLE RATED pours behind them or the match is null
 * and the surface hides it, the same way `tasteMatchPercent` hides a
 * bottle match before the palate has signal. Rated specifically: an unrated
 * pour contributes a flat UNRATED_WEIGHT toward whatever the bottle's catalog
 * profile says, so three of those on each side would let two people who have
 * never expressed an opinion read as a high match. Hence `ratedSampleSize`
 * rather than `sampleSize` everywhere in this file.
 *
 * Nothing here counts or ranks pour volume: a twin is someone who tastes like
 * you, never someone who drinks more than you.
 */

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import { cosineSimilarity, type PalateVector } from "@/lib/palate";
import { getUserPalate, getUserPalates } from "@/lib/palate-store";
import { acceptedFollowSql, contributorVisibleSql } from "@/lib/social";

/**
 * Rated pours each side needs before a match is reported — counted as
 * `PalateProfileResult.ratedSampleSize`, never the looser `sampleSize`. Three
 * is the same floor the Home dashboard uses to decide it has enough to
 * describe a month.
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
  aRatedSample: number,
  b: PalateVector,
  bRatedSample: number,
): number | null {
  if (aRatedSample < MIN_TWIN_SAMPLE || bRatedSample < MIN_TWIN_SAMPLE) return null;
  // Enough pours, no direction: rate three drams a flat 3 and every weight is
  // (3 - NEUTRAL_RATING) = 0. Cosine is undefined against a zero-magnitude
  // vector, and `cosineSimilarity` reports that as 0 — which would render as a
  // confident "0% palate match" between two people who have expressed no
  // preference at all. Unknown, not opposite.
  if (!hasDirection(a) || !hasDirection(b)) return null;
  const sim = cosineSimilarity(a, b);
  if (sim <= 0) return 0;
  return Math.round(sim * 100);
}

/** Any non-zero weight — i.e. the palate points somewhere. */
function hasDirection(vector: PalateVector): boolean {
  return Object.values(vector).some((weight) => weight !== 0);
}

/**
 * Pour rows the viewer may derive a palate from: their own, plus anyone who is
 * visible to them AND whom they still hold an accepted follow on. Handed to
 * `getUserPalates` so both halves run in the statement that reads the pours —
 * anything that changes after `visibleFolloweeIds` returned would otherwise let
 * a stale id list produce a match built from that person's whole history,
 * private pours included.
 *
 * Both halves are needed, and they revoke access by different means: a block or
 * a step-back (`socialEnabled: false`) leaves the accepted follow row intact,
 * so the follow check alone would still authorize the read; an unfollow leaves
 * the profile perfectly visible, so `contributorVisibleSql` alone would too.
 */
export function palateReadableBy(viewerId: string) {
  return and(
    contributorVisibleSql(schema.pours.userId, viewerId),
    or(eq(schema.pours.userId, viewerId), acceptedFollowSql(viewerId, schema.pours.userId)),
  )!;
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
  if (!viewerId) return null;
  const matches = await getPalateMatches(db, viewerId, [otherUserId]);
  return matches.get(otherUserId) ?? null;
}

/**
 * Matches for a SPECIFIC set of people — the authors actually on screen.
 *
 * Surfaces that render a fixed handful of notes ask for exactly those authors
 * rather than ranking the whole graph and hoping the people they are showing
 * land in the top slice: a viewer following hundreds would otherwise see the
 * chip vanish from a recent note purely because that author sat outside an
 * arbitrary cut. Two queries regardless of how many people are asked about.
 */
export async function getPalateMatches(
  db: DB,
  viewerId: string,
  userIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = [...new Set(userIds)].filter((id) => id !== viewerId);
  if (wanted.length === 0) return out;

  const followees = new Set(await visibleFolloweeIds(db, viewerId));
  const eligible = wanted.filter((id) => followees.has(id));
  if (eligible.length === 0) return out;

  const palates = await getUserPalates(
    db,
    [viewerId, ...eligible],
    undefined,
    palateReadableBy(viewerId),
  );
  const mine = palates.get(viewerId);
  if (!mine) return out;

  for (const id of eligible) {
    const theirs = palates.get(id);
    if (!theirs) continue;
    const match = palateMatchPercent(
      mine.vector,
      mine.ratedSampleSize,
      theirs.vector,
      theirs.ratedSampleSize,
    );
    if (match != null) out.set(id, match);
  }
  return out;
}

/**
 * The viewer's closest palates among the people they follow, strongest first.
 *
 * Two exclusions, for different reasons. A match that cannot be computed is
 * left out rather than shown at 0 — "we don't know yet" and "you taste nothing
 * alike" are different claims. A match that computes to 0 is left out too:
 * this list is the endorsement pool, and a 0% match is someone whose palate is
 * orthogonal or outright opposite to the viewer's. Letting their rating carry
 * a "tastes like you" sentence (or nudge the ranking) would be the reverse of
 * the signal it claims to be.
 *
 * `getPalateMatch`/`getPalateMatches` deliberately keep reporting 0 — on a
 * profile that is an honest answer to "how alike are we", and nothing acts on
 * it. Only this pool feeds recommendations.
 */
export async function getTasteTwins(db: DB, viewerId: string, limit = 5): Promise<TasteTwin[]> {
  const followeeIds = await visibleFolloweeIds(db, viewerId);
  if (followeeIds.length === 0) return [];

  const mine = await getUserPalate(db, viewerId);
  if (mine.ratedSampleSize < MIN_TWIN_SAMPLE) return [];

  const profiles: Array<{
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
  }> = await db
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

  // One query for every followee's palate rather than one per followee: a
  // viewer following hundreds of people would otherwise add hundreds of
  // sequential round trips to a Home render.
  const palates = await getUserPalates(
    db,
    profiles.map((p) => p.userId),
    undefined,
    palateReadableBy(viewerId),
  );

  const twins: TasteTwin[] = [];
  for (const profile of profiles) {
    const theirs = palates.get(profile.userId);
    if (!theirs) continue;
    const matchPercent = palateMatchPercent(
      mine.vector,
      mine.ratedSampleSize,
      theirs.vector,
      theirs.ratedSampleSize,
    );
    if (matchPercent == null || matchPercent <= 0) continue;
    twins.push({ ...profile, matchPercent });
  }

  return twins
    .sort((a, b) => b.matchPercent - a.matchPercent || a.handle.localeCompare(b.handle))
    .slice(0, limit);
}

export interface TwinEndorsement {
  bottleId: string;
  /** How many distinct twins rated it at or above ENDORSEMENT_RATING. */
  twinCount: number;
  /** The closest-matching endorser, for the reason line. */
  topTwin: TasteTwin;
  /** THAT twin's own best rating — never another endorser's. */
  topTwinRating: number;
  /**
   * The lowest of the endorsers' best ratings, so a group can be described as
   * "rated it 4.5+" and have every one of them actually clear that bar.
   */
  minRating: number;
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
 *
 * Every relationship in that gate is re-checked IN this query rather than
 * taken from `twins`, which is a snapshot from a `getTasteTwins` call earlier
 * in the request. A follow revoked in between would otherwise leave the
 * snapshot admitting a `followers`-visibility pour the viewer can no longer
 * see — and the reason names the person, so the leak is attributed. The
 * accepted follow is also what makes someone a twin at all, so requiring it
 * here keeps the sentence's premise true even for a public pour.
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

  const visibilityCond = or(
    inArray(schema.pours.visibility, ["followers", "public"]),
    // Friends-only needs the author following the viewer back, checked here
    // rather than pre-loaded into an id list for the same reason.
    and(
      eq(schema.pours.visibility, "friends"),
      acceptedFollowSql(schema.pours.userId, viewerId),
    ),
  );

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
        acceptedFollowSql(viewerId, schema.pours.userId),
        visibilityCond,
      ),
    )
    .orderBy(desc(schema.pours.rating));

  // Each twin's OWN best rating per bottle. Keeping ratings attached to the
  // person who gave them is the whole point: a reason that names one twin and
  // quotes another's score is a quote nobody said. A twin who poured a bottle
  // twice is still one voice.
  const bestByBottleAndTwin = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!twinById.has(row.userId) || row.rating == null) continue;
    const perTwin = bestByBottleAndTwin.get(row.bottleId) ?? new Map<string, number>();
    perTwin.set(row.userId, Math.max(perTwin.get(row.userId) ?? 0, row.rating));
    bestByBottleAndTwin.set(row.bottleId, perTwin);
  }

  for (const [bottleId, perTwin] of bestByBottleAndTwin) {
    let topTwin: TasteTwin | null = null;
    let topTwinRating = 0;
    let minRating = Infinity;
    for (const [twinId, rating] of perTwin) {
      const twin = twinById.get(twinId)!;
      if (rating < minRating) minRating = rating;
      if (!topTwin || twin.matchPercent > topTwin.matchPercent) {
        topTwin = twin;
        topTwinRating = rating;
      }
    }
    if (!topTwin) continue;
    out.set(bottleId, {
      bottleId,
      twinCount: perTwin.size,
      topTwin,
      topTwinRating,
      minRating,
    });
  }

  return out;
}

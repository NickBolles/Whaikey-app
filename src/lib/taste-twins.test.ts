import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { NEUTRAL_RATING } from "@/lib/palate";
import { getUserPalates } from "@/lib/palate-store";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  MIN_TWIN_SAMPLE,
  getPalateMatch,
  getPalateMatches,
  getTasteTwins,
  getTwinEndorsements,
  palateMatchPercent,
  palateReadableBy,
} from "./taste-twins";

describe("palateMatchPercent", () => {
  const sweet = { sweet: 1, woody: 0.5 };
  const alsoSweet = { sweet: 0.8, woody: 0.4 };
  const peaty = { peaty: 1 };

  it("scores aligned palates high and unrelated ones low", () => {
    expect(palateMatchPercent(sweet, 5, alsoSweet, 5)).toBe(100);
    expect(palateMatchPercent(sweet, 5, peaty, 5)).toBe(0);
  });

  it("reports an opposite palate as 0 rather than a negative percentage", () => {
    expect(palateMatchPercent({ sweet: 1 }, 5, { sweet: -1 }, 5)).toBe(0);
  });

  it("calls a palate with no direction unknown, not 0%", () => {
    // Three flat 3s: every weight is (3 - NEUTRAL_RATING) = 0, so cosine has
    // nothing to measure against. "No preference expressed" must not render as
    // a confident "you taste nothing alike".
    const flat = { sweet: 0, peaty: 0 };
    expect(palateMatchPercent(flat, 9, alsoSweet, 9)).toBeNull();
    expect(palateMatchPercent(sweet, 9, flat, 9)).toBeNull();
    expect(palateMatchPercent(flat, 9, flat, 9)).toBeNull();
  });

  it("stays null until BOTH palates carry enough rated pours", () => {
    expect(palateMatchPercent(sweet, MIN_TWIN_SAMPLE - 1, alsoSweet, 9)).toBeNull();
    expect(palateMatchPercent(sweet, 9, alsoSweet, MIN_TWIN_SAMPLE - 1)).toBeNull();
    expect(palateMatchPercent(sweet, MIN_TWIN_SAMPLE, alsoSweet, MIN_TWIN_SAMPLE)).not.toBeNull();
  });
});

describe("taste twins against the graph", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  async function profile(userId: string, handle: string, socialEnabled = true) {
    await db.insert(schema.userProfiles).values({
      userId,
      handle,
      displayName: handle,
      isPublic: true,
      socialEnabled,
    });
  }

  async function follow(followerId: string, followeeId: string) {
    await db.insert(schema.follows).values({
      id: uid("f"),
      followerId,
      followeeId,
      state: "accepted",
    });
  }

  /** Rated pours give a user a palate; the profile drives which way it leans. */
  async function seedPalate(
    userId: string,
    bottleProfile: Record<string, number>,
    count = MIN_TWIN_SAMPLE,
    rating: number | null = 5,
  ) {
    const bottle = await createTestBottle(db, { name: uid("b"), flavorProfile: bottleProfile });
    for (let i = 0; i < count; i++) {
      await db.insert(schema.pours).values({
        id: uid("pour"),
        userId,
        bottleId: bottle.id,
        rating,
      });
    }
    return bottle;
  }

  it("ranks the people you follow by how closely they taste like you", async () => {
    const viewer = await createTestUser(db);
    const close = await createTestUser(db);
    const distant = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(close.id, "close");
    await profile(distant.id, "distant");
    await follow(viewer.id, close.id);
    await follow(viewer.id, distant.id);

    await seedPalate(viewer.id, { peaty: 9 });
    await seedPalate(close.id, { peaty: 8 });
    // Overlapping but mostly elsewhere: a real, lower match. A palate with no
    // overlap at all scores 0 and is excluded outright (see below), so it
    // couldn't stand in for "distant" here.
    await seedPalate(distant.id, { peaty: 3, sweet: 9 });

    const twins = await getTasteTwins(db, viewer.id);
    expect(twins.map((t) => t.handle)).toEqual(["close", "distant"]);
    expect(twins[0].matchPercent).toBeGreaterThan(twins[1].matchPercent);
  });

  it("never makes a stranger a twin, however alike their palate", async () => {
    const viewer = await createTestUser(db);
    const stranger = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(stranger.id, "stranger");
    await seedPalate(viewer.id, { peaty: 9 });
    await seedPalate(stranger.id, { peaty: 9 });

    // Identical palates, but no accepted follow — S4 territory, not S3.
    expect(await getTasteTwins(db, viewer.id)).toEqual([]);
    expect(await getPalateMatch(db, viewer.id, stranger.id)).toBeNull();
  });

  it("drops a followee who has blocked the viewer or stepped back", async () => {
    const viewer = await createTestUser(db);
    const blocker = await createTestUser(db);
    const steppedBack = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(blocker.id, "blocker");
    await profile(steppedBack.id, "steppedback", false);
    await follow(viewer.id, blocker.id);
    await follow(viewer.id, steppedBack.id);
    await seedPalate(viewer.id, { peaty: 9 });
    await seedPalate(blocker.id, { peaty: 9 });
    await seedPalate(steppedBack.id, { peaty: 9 });
    await db
      .insert(schema.blocks)
      .values({ id: uid("blk"), blockerId: blocker.id, blockedId: viewer.id });

    expect(await getTasteTwins(db, viewer.id)).toEqual([]);
    expect(await getPalateMatch(db, viewer.id, blocker.id)).toBeNull();
  });

  it("leaves out a followee whose palate is still too thin, rather than showing 0%", async () => {
    const viewer = await createTestUser(db);
    const fresh = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(fresh.id, "fresh");
    await follow(viewer.id, fresh.id);
    await seedPalate(viewer.id, { peaty: 9 });
    await seedPalate(fresh.id, { peaty: 9 }, MIN_TWIN_SAMPLE - 1);

    expect(await getTasteTwins(db, viewer.id)).toEqual([]);
    expect(await getPalateMatch(db, viewer.id, fresh.id)).toBeNull();
  });

  it("never counts unrated pours toward the evidence floor", async () => {
    // Both sides have three pours of a peaty bottle and not one opinion between
    // them. The vectors align perfectly (they're the same catalog profile at a
    // flat UNRATED_WEIGHT), so a floor counting any usable pour would report a
    // twin out of nothing but two people having poured the same thing.
    const viewer = await createTestUser(db);
    const other = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(other.id, "other");
    await follow(viewer.id, other.id);
    await seedPalate(viewer.id, { peaty: 9 }, MIN_TWIN_SAMPLE, null);
    await seedPalate(other.id, { peaty: 9 }, MIN_TWIN_SAMPLE, null);

    expect(await getTasteTwins(db, viewer.id)).toEqual([]);
    expect(await getPalateMatch(db, viewer.id, other.id)).toBeNull();

    // One rated pour each is still short of the floor; three each clears it.
    await seedPalate(viewer.id, { peaty: 9 }, 1);
    await seedPalate(other.id, { peaty: 9 }, 1);
    expect(await getPalateMatch(db, viewer.id, other.id)).toBeNull();

    await seedPalate(viewer.id, { peaty: 9 }, MIN_TWIN_SAMPLE);
    await seedPalate(other.id, { peaty: 9 }, MIN_TWIN_SAMPLE);
    expect(await getPalateMatch(db, viewer.id, other.id)).not.toBeNull();
  });

  it("keeps a 0% match off the endorsement pool while still reporting it", async () => {
    // Opposite palates: peaty liked, sweet disliked on one side and the mirror
    // on the other. A 0% match is evidence AGAINST taking their word for a
    // bottle, so they must not become a twin — but the profile-level number is
    // still an honest answer to "how alike are we".
    const viewer = await createTestUser(db);
    const opposite = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(opposite.id, "opposite");
    await follow(viewer.id, opposite.id);
    await seedPalate(viewer.id, { peaty: 9 }, MIN_TWIN_SAMPLE, 5);
    await seedPalate(opposite.id, { peaty: 9 }, MIN_TWIN_SAMPLE, 1);

    expect(await getPalateMatch(db, viewer.id, opposite.id)).toBe(0);
    expect(await getTasteTwins(db, viewer.id)).toEqual([]);
  });

  it("reports nothing for two drinkers who rated everything neutral", async () => {
    const viewer = await createTestUser(db);
    const neutral = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(neutral.id, "neutral");
    await follow(viewer.id, neutral.id);
    await seedPalate(viewer.id, { peaty: 9 }, MIN_TWIN_SAMPLE, NEUTRAL_RATING);
    await seedPalate(neutral.id, { peaty: 9 }, MIN_TWIN_SAMPLE, NEUTRAL_RATING);

    expect(await getPalateMatch(db, viewer.id, neutral.id)).toBeNull();
    expect(await getTasteTwins(db, viewer.id)).toEqual([]);
  });

  it("authorizes the palate read itself, not just the followee list", async () => {
    // The id list and the palate query are two reads. Everything that can
    // revoke access between them is re-checked in the second one — and the
    // revocations work differently: a block or a step-back leaves the accepted
    // follow intact, an unfollow leaves the profile perfectly visible.
    const viewer = await createTestUser(db);
    const followee = await createTestUser(db);
    const blocker = await createTestUser(db);
    const steppedBack = await createTestUser(db);
    const stranger = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(followee.id, "followee");
    await profile(blocker.id, "blocker");
    await profile(steppedBack.id, "steppedback", false);
    await profile(stranger.id, "stranger");
    for (const u of [followee, blocker, steppedBack]) await follow(viewer.id, u.id);
    for (const u of [viewer, followee, blocker, steppedBack, stranger]) {
      await seedPalate(u.id, { peaty: 9 });
    }
    await db
      .insert(schema.blocks)
      .values({ id: uid("blk"), blockerId: blocker.id, blockedId: viewer.id });

    const palates = await getUserPalates(
      db,
      [viewer.id, followee.id, blocker.id, steppedBack.id, stranger.id],
      undefined,
      palateReadableBy(viewer.id),
    );
    expect([...palates.keys()].sort()).toEqual([followee.id, viewer.id].sort());
  });

  it("shows a suspended viewer no twins, and no matches either", async () => {
    const viewer = await createTestUser(db);
    const close = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(close.id, "close");
    await follow(viewer.id, close.id);
    await seedPalate(viewer.id, { peaty: 9 });
    await seedPalate(close.id, { peaty: 8 });

    // Everything is in place first, so the assertions below can only be the
    // suspension talking.
    expect((await getTasteTwins(db, viewer.id)).length).toBe(1);
    expect(await getPalateMatch(db, viewer.id, close.id)).not.toBeNull();

    await db
      .update(schema.userProfiles)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.userProfiles.userId, viewer.id));

    // Taste twins reach another account's palate without ever going through
    // social.ts's own read functions, so the guard has to sit on this path in
    // its own right (review §5.4).
    expect(await getTasteTwins(db, viewer.id)).toEqual([]);
    expect(await getPalateMatch(db, viewer.id, close.id)).toBeNull();
    expect((await getPalateMatches(db, viewer.id, [close.id])).size).toBe(0);
  });

  it("still reads a suspended followee's palate: the sanction is on the viewer", async () => {
    const viewer = await createTestUser(db);
    const close = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(close.id, "close");
    await follow(viewer.id, close.id);
    await seedPalate(viewer.id, { peaty: 9 });
    await seedPalate(close.id, { peaty: 8 });

    await db
      .update(schema.userProfiles)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.userProfiles.userId, close.id));

    // A suspension stops that account posting and reading, not everyone else
    // from seeing what it already published. Hiding their contributions is
    // what `hideSubject` is for, and it is a separate decision a moderator
    // makes explicitly.
    expect((await getTasteTwins(db, viewer.id)).map((t) => t.handle)).toEqual(["close"]);
  });

  it("gives no self-match", async () => {
    const viewer = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await seedPalate(viewer.id, { peaty: 9 });
    expect(await getPalateMatch(db, viewer.id, viewer.id)).toBeNull();
    expect(await getPalateMatch(db, null, viewer.id)).toBeNull();
  });
});

describe("getTwinEndorsements", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  const twin = (userId: string, handle: string, matchPercent: number) => ({
    userId,
    handle,
    displayName: handle,
    avatarUrl: null,
    matchPercent,
  });

  /**
   * A twin is by definition someone the viewer follows, and the endorsement
   * query re-checks that live rather than trusting the passed-in list — so the
   * follow has to exist for any of these fixtures to be visible.
   *
   * And the profile with it: `followUser` refuses a target that has none, so a
   * followee without one is a state the app cannot produce. These fixtures
   * skipped it only because nothing had ever required it — until
   * `contributorVisibleSql` started asking for a socially present author
   * rather than merely one not switched off.
   */
  async function followedTwin(
    viewerId: string,
    userId: string,
    handle: string,
    matchPercent: number,
  ) {
    await db.insert(schema.userProfiles).values({
      userId,
      handle,
      displayName: handle,
      isPublic: true,
      socialEnabled: true,
    });
    await db.insert(schema.follows).values({
      id: uid("f"),
      followerId: viewerId,
      followeeId: userId,
      state: "accepted",
    });
    return twin(userId, handle, matchPercent);
  }

  async function ratedPour(
    userId: string,
    bottleId: string,
    rating: number,
    visibility: schema.PourVisibility,
  ) {
    await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId, bottleId, rating, visibility });
  }

  it("counts distinct twins who rated a bottle highly and credits the closest", async () => {
    const viewer = await createTestUser(db);
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "Shared Favourite" });

    await ratedPour(a.id, bottle.id, 4.5, "public");
    await ratedPour(a.id, bottle.id, 4, "public"); // same voice, poured twice
    await ratedPour(b.id, bottle.id, 5, "public");

    const found = await getTwinEndorsements(db, viewer.id, [bottle.id], [
      await followedTwin(viewer.id, a.id, "closest", 91),
      await followedTwin(viewer.id, b.id, "further", 70),
    ]);
    const entry = found.get(bottle.id)!;
    expect(entry.twinCount).toBe(2);
    // The closest twin is credited with HER OWN rating, not the group's best.
    expect(entry.topTwin.handle).toBe("closest");
    expect(entry.topTwinRating).toBe(4.5);
    // Every endorser cleared this bar, so a "4.5+" style claim stays true.
    expect(entry.minRating).toBe(4.5);
  });

  it("never credits one twin with another's rating", async () => {
    const viewer = await createTestUser(db);
    const closest = await createTestUser(db);
    const other = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "Split Opinion" });

    // The closest match liked it least — the earlier bug reported the group's
    // best (5) beside the closest twin's handle, quoting words she never said.
    await ratedPour(closest.id, bottle.id, 4, "public");
    await ratedPour(other.id, bottle.id, 5, "public");

    const found = await getTwinEndorsements(db, viewer.id, [bottle.id], [
      await followedTwin(viewer.id, closest.id, "closest", 95),
      await followedTwin(viewer.id, other.id, "other", 60),
    ]);
    const entry = found.get(bottle.id)!;
    expect(entry.topTwin.handle).toBe("closest");
    expect(entry.topTwinRating).toBe(4);
    // Every endorser cleared 4, so "4+" describes the group truthfully.
    expect(entry.minRating).toBe(4);
  });

  it("ignores ratings below the endorsement bar", async () => {
    const viewer = await createTestUser(db);
    const a = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "Just OK" });
    await ratedPour(a.id, bottle.id, 3.5, "public");

    const found = await getTwinEndorsements(db, viewer.id, [bottle.id], [
      await followedTwin(viewer.id, a.id, "a", 90),
    ]);
    expect(found.size).toBe(0);
  });

  it("never leaks a private pour's rating into a recommendation", async () => {
    const viewer = await createTestUser(db);
    const a = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "Private Love" });
    await ratedPour(a.id, bottle.id, 5, "private");

    const found = await getTwinEndorsements(db, viewer.id, [bottle.id], [
      await followedTwin(viewer.id, a.id, "a", 95),
    ]);
    expect(found.size).toBe(0);
  });

  it("uses a friends-only pour only when that twin follows the viewer back", async () => {
    const viewer = await createTestUser(db);
    const oneWay = await createTestUser(db);
    const mutual = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "Friends Only" });
    await ratedPour(oneWay.id, bottle.id, 5, "friends");
    await ratedPour(mutual.id, bottle.id, 5, "friends");
    await db.insert(schema.follows).values({
      id: uid("f"),
      followerId: mutual.id,
      followeeId: viewer.id,
      state: "accepted",
    });

    const oneWayOnly = await getTwinEndorsements(db, viewer.id, [bottle.id], [
      await followedTwin(viewer.id, oneWay.id, "oneway", 90),
    ]);
    expect(oneWayOnly.size).toBe(0);

    const mutualOnly = await getTwinEndorsements(db, viewer.id, [bottle.id], [
      await followedTwin(viewer.id, mutual.id, "mutual", 90),
    ]);
    expect(mutualOnly.get(bottle.id)?.twinCount).toBe(1);
  });

  it("stops disclosing a rating the moment the follow is revoked", async () => {
    // `twins` is a snapshot taken earlier in the request. If the viewer
    // unfollows in between, a followers-visibility pour is no longer theirs to
    // see — and the reason would have named the person it leaked from.
    const viewer = await createTestUser(db);
    const author = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "Revoked" });
    await ratedPour(author.id, bottle.id, 5, "followers");
    const stale = await followedTwin(viewer.id, author.id, "author", 90);

    expect((await getTwinEndorsements(db, viewer.id, [bottle.id], [stale])).size).toBe(1);

    await db.delete(schema.follows).where(eq(schema.follows.followerId, viewer.id));
    expect((await getTwinEndorsements(db, viewer.id, [bottle.id], [stale])).size).toBe(0);
  });

  it("drops a friends-only pour when the author's follow back is revoked", async () => {
    const viewer = await createTestUser(db);
    const author = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "Was Mutual" });
    await ratedPour(author.id, bottle.id, 5, "friends");
    const stale = await followedTwin(viewer.id, author.id, "author", 90);
    await db.insert(schema.follows).values({
      id: uid("f"),
      followerId: author.id,
      followeeId: viewer.id,
      state: "accepted",
    });

    expect((await getTwinEndorsements(db, viewer.id, [bottle.id], [stale])).size).toBe(1);

    await db.delete(schema.follows).where(eq(schema.follows.followerId, author.id));
    expect((await getTwinEndorsements(db, viewer.id, [bottle.id], [stale])).size).toBe(0);
  });

  it("does not admit a public pour from someone the viewer never followed", async () => {
    // The accepted follow is what makes the person a twin at all, so "public"
    // is not enough to earn a "tastes like you" sentence about them.
    const viewer = await createTestUser(db);
    const stranger = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "Stranger's Pick" });
    await ratedPour(stranger.id, bottle.id, 5, "public");

    const found = await getTwinEndorsements(db, viewer.id, [bottle.id], [
      twin(stranger.id, "stranger", 95),
    ]);
    expect(found.size).toBe(0);
  });

  it("returns no endorsements to a suspended viewer, even with a twin list in hand", async () => {
    const viewer = await createTestUser(db);
    const a = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "Shared Favourite" });
    await ratedPour(a.id, bottle.id, 5, "public");
    const twins = [await followedTwin(viewer.id, a.id, "closest", 91)];
    // The viewer needs a profile row of their own for a suspension to land on;
    // the other fixtures in this block never gave them one because nothing had
    // ever read the viewer's own profile.
    await db.insert(schema.userProfiles).values({
      userId: viewer.id,
      handle: "viewer",
      displayName: "viewer",
      isPublic: true,
      socialEnabled: true,
    });

    expect((await getTwinEndorsements(db, viewer.id, [bottle.id], twins)).size).toBe(1);

    await db
      .update(schema.userProfiles)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.userProfiles.userId, viewer.id));

    // `getTasteTwins` would hand a suspended viewer an empty list, so this can
    // only be reached with a list built elsewhere or carried over from before
    // the suspension — which is exactly why this export carries its own gate
    // rather than relying on its caller's.
    expect((await getTwinEndorsements(db, viewer.id, [bottle.id], twins)).size).toBe(0);
  });

  it("returns nothing without bottles or twins to work with", async () => {
    const viewer = await createTestUser(db);
    expect((await getTwinEndorsements(db, viewer.id, [], [twin("x", "x", 90)])).size).toBe(0);
    expect((await getTwinEndorsements(db, viewer.id, ["b"], [])).size).toBe(0);
  });
});

describe("getPalateMatches", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  async function profile(userId: string, handle: string) {
    await db.insert(schema.userProfiles).values({
      userId,
      handle,
      displayName: handle,
      isPublic: true,
      socialEnabled: true,
    });
  }

  async function seedPalate(userId: string, bottleProfile: Record<string, number>) {
    const bottle = await createTestBottle(db, { name: uid("b"), flavorProfile: bottleProfile });
    for (let i = 0; i < MIN_TWIN_SAMPLE; i++) {
      await db
        .insert(schema.pours)
        .values({ id: uid("pour"), userId, bottleId: bottle.id, rating: 5 });
    }
  }

  it("answers for the people asked about, however far down the graph they rank", async () => {
    const viewer = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await seedPalate(viewer.id, { peaty: 9 });

    // A close match and a distant one. Asking about the distant one alone must
    // still answer — a ranked top-N lookup would have dropped it.
    const close = await createTestUser(db);
    const distant = await createTestUser(db);
    for (const [u, handle, prof] of [
      [close, "close", { peaty: 9 }],
      [distant, "distant", { sweet: 9 }],
    ] as const) {
      await profile(u.id, handle);
      await db.insert(schema.follows).values({
        id: uid("f"),
        followerId: viewer.id,
        followeeId: u.id,
        state: "accepted",
      });
      await seedPalate(u.id, prof);
    }

    const only = await getPalateMatches(db, viewer.id, [distant.id]);
    expect(only.has(distant.id)).toBe(true);

    const both = await getPalateMatches(db, viewer.id, [close.id, distant.id]);
    expect(both.get(close.id)!).toBeGreaterThan(both.get(distant.id)!);
  });

  it("keeps the same scope rules as the ranked lookup", async () => {
    const viewer = await createTestUser(db);
    const stranger = await createTestUser(db);
    await profile(viewer.id, "viewer");
    await profile(stranger.id, "stranger");
    await seedPalate(viewer.id, { peaty: 9 });
    await seedPalate(stranger.id, { peaty: 9 });

    // Not followed, and never yourself.
    expect((await getPalateMatches(db, viewer.id, [stranger.id])).size).toBe(0);
    expect((await getPalateMatches(db, viewer.id, [viewer.id])).size).toBe(0);
    expect((await getPalateMatches(db, viewer.id, [])).size).toBe(0);
  });
});

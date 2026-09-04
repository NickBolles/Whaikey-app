import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { InvalidPhoneError } from "@/lib/phone";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  COMMENT_EDIT_WINDOW_MS,
  COMMENT_RATE_LIMIT_PER_HOUR,
  HandleTakenError,
  InvalidHandleError,
  PHONE_LOOKUP_LIMIT_PER_HOUR,
  PhoneTakenError,
  RateLimitedError,
  SocialDisabledError,
  addComment,
  approveFollow,
  areFriends,
  blockUser,
  canViewPour,
  cheerPour,
  clearPhone,
  createProfile,
  createReport,
  denyFollow,
  editComment,
  findProfileByPhone,
  followByHandle,
  getAddTarget,
  getFriendFeed,
  getFriendNotesForBottle,
  getOwnProfile,
  getPalateCard,
  getProfileView,
  getSocialNote,
  getSocialPrefs,
  isBlockedEither,
  isReservedHandle,
  isValidHandle,
  listBlocked,
  listComments,
  listFollowRequests,
  listFollowers,
  listFollowing,
  makeEverythingPrivate,
  normalizeHandle,
  profileCreateSchema,
  profileUpdateSchema,
  removeFollower,
  setPhone,
  setPhoneDiscoverable,
  softDeleteComment,
  uncheerPour,
  unblockUser,
  unfollow,
  updateProfile,
  updateSocialPrefs,
  type SocialNote,
} from "@/lib/social";
import type { PourVisibility } from "@/db/schema";

// Test setup helper: claim a handle, then apply arbitrary profile-row
// overrides directly (bypassing updateProfile, whose patch surface is
// intentionally narrower than every column — e.g. it never sets
// socialEnabled, which only createProfile/makeEverythingPrivate touch).
async function claim(
  db: DB,
  user: schema.User,
  handle: string,
  overrides: Partial<typeof schema.userProfiles.$inferInsert> = {},
) {
  await createProfile(db, user, handle);
  if (Object.keys(overrides).length === 0) return getOwnProfile(db, user.id);
  await db.update(schema.userProfiles).set(overrides).where(eq(schema.userProfiles.userId, user.id));
  return getOwnProfile(db, user.id);
}

async function insertPour(
  db: DB,
  userId: string,
  bottleId: string,
  overrides: Partial<typeof schema.pours.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.pours)
    .values({ id: uid("pour"), userId, bottleId, ...overrides })
    .returning();
  return row;
}

async function insertNote(db: DB, pourId: string, overrides: Partial<typeof schema.tastingNotes.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.tastingNotes)
    .values({ id: uid("note"), pourId, extractedBy: "user", ...overrides })
    .returning();
  return row;
}

describe("handles", () => {
  it("normalizes, validates, and reserves", () => {
    expect(normalizeHandle("  Dram_Wanderer  ")).toBe("dram_wanderer");
    expect(isValidHandle("dram_wanderer")).toBe(true);
    expect(isValidHandle("ab")).toBe(false); // too short
    expect(isValidHandle("a".repeat(21))).toBe(false); // too long
    expect(isValidHandle("Has-Dash")).toBe(false); // uppercase/dash not allowed
    expect(isReservedHandle("ADMIN")).toBe(true);
    expect(isReservedHandle("macallan")).toBe(true);
    expect(isReservedHandle("dram_wanderer")).toBe(false);
  });
});

describe("profiles", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("creates a profile with defaults from the user, rejects invalid/reserved handles, and enforces uniqueness", async () => {
    const user = await createTestUser(db, { name: "Avery" });
    const profile = await createProfile(
      db,
      { id: user.id, name: user.name, image: "https://img/avery.png" },
      "  Avery_Drams  ",
    );
    expect(profile).toMatchObject({
      userId: user.id,
      handle: "avery_drams",
      displayName: "Avery",
      avatarUrl: "https://img/avery.png",
      isPublic: false,
      discoverable: true,
      socialEnabled: true,
    });

    await expect(createProfile(db, await createTestUser(db), "ab")).rejects.toBeInstanceOf(InvalidHandleError);
    await expect(createProfile(db, await createTestUser(db), "macallan")).rejects.toBeInstanceOf(InvalidHandleError);

    const stranger = await createTestUser(db);
    await expect(createProfile(db, stranger, "Avery_Drams")).rejects.toBeInstanceOf(HandleTakenError);
  });

  it("updates only provided fields", async () => {
    const user = await createTestUser(db, { name: "Nick" });
    await createProfile(db, user, "nick_tastes");
    const updated = await updateProfile(db, user.id, { bio: "Peat forever", isPublic: true });
    expect(updated).toMatchObject({ bio: "Peat forever", isPublic: true, displayName: "Nick" });
    expect(await updateProfile(db, "nope", { bio: "x" })).toBeNull();
  });
});

describe("follow graph", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("follows a public profile as accepted and a private one as pending, and is idempotent", async () => {
    const a = await createTestUser(db);
    const publicUser = await createTestUser(db);
    const privateUser = await createTestUser(db);
    await claim(db, a, "a_taster");
    await claim(db, publicUser, "pub_taster", { isPublic: true });
    await claim(db, privateUser, "priv_taster", { isPublic: false });

    const toPublic = await followByHandle(db, a.id, "pub_taster");
    expect(toPublic).toEqual({ state: "accepted" });
    const again = await followByHandle(db, a.id, "pub_taster");
    expect(again).toEqual({ state: "accepted" });

    const toPrivate = await followByHandle(db, a.id, "priv_taster");
    expect(toPrivate).toEqual({ state: "pending" });
  });

  it("returns null for missing/self/blocked/socialEnabled=false targets, indistinguishably", async () => {
    const a = await createTestUser(db);
    await claim(db, a, "a_taster");
    expect(await followByHandle(db, a.id, "nobody")).toBeNull();
    expect(await followByHandle(db, a.id, "a_taster")).toBeNull(); // self

    const disabled = await createTestUser(db);
    await claim(db, disabled, "off_taster", { socialEnabled: false });
    expect(await followByHandle(db, a.id, "off_taster")).toBeNull();

    const blocker = await createTestUser(db);
    await claim(db, blocker, "blocker_taster", { isPublic: true });
    await blockUser(db, blocker.id, a.id);
    expect(await followByHandle(db, a.id, "blocker_taster")).toBeNull();
  });

  it("approve/deny/unfollow/removeFollower and listing", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    const c = await createTestUser(db);
    await claim(db, a, "a_taster");
    await claim(db, b, "b_taster", { isPublic: false });
    await claim(db, c, "c_taster", { isPublic: true });

    await followByHandle(db, a.id, "b_taster");
    expect(await listFollowRequests(db, b.id)).toHaveLength(1);

    expect(await approveFollow(db, b.id, a.id)).toBe(true);
    expect(await listFollowRequests(db, b.id)).toHaveLength(0);
    expect(await listFollowers(db, b.id)).toHaveLength(1);
    expect(await listFollowing(db, a.id)).toEqual([expect.objectContaining({ userId: b.id, state: "accepted" })]);

    expect(await removeFollower(db, b.id, a.id)).toBe(true);
    expect(await listFollowers(db, b.id)).toHaveLength(0);

    await followByHandle(db, a.id, "b_taster");
    expect(await denyFollow(db, b.id, a.id)).toBe(true);
    expect(await listFollowRequests(db, b.id)).toHaveLength(0);

    await followByHandle(db, a.id, "c_taster");
    expect(await unfollow(db, a.id, c.id)).toBe(true);
    expect(await listFollowing(db, a.id)).toHaveLength(0);
  });

  it("areFriends requires a mutual accepted follow", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    await claim(db, a, "a_taster", { isPublic: true });
    await claim(db, b, "b_taster", { isPublic: true });

    await followByHandle(db, a.id, "b_taster");
    expect(await areFriends(db, a.id, b.id)).toBe(false);

    await followByHandle(db, b.id, "a_taster");
    expect(await areFriends(db, a.id, b.id)).toBe(true);
    expect(await areFriends(db, a.id, a.id)).toBe(false);
  });
});

describe("blocks", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("severs existing follows in both directions and is idempotent", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    await claim(db, a, "a_taster", { isPublic: true });
    await claim(db, b, "b_taster", { isPublic: true });
    await followByHandle(db, a.id, "b_taster");
    await followByHandle(db, b.id, "a_taster");
    expect(await areFriends(db, a.id, b.id)).toBe(true);

    await blockUser(db, a.id, b.id);
    await blockUser(db, a.id, b.id); // idempotent
    expect(await areFriends(db, a.id, b.id)).toBe(false);
    expect(await isBlockedEither(db, a.id, b.id)).toBe(true);
    expect(await isBlockedEither(db, b.id, a.id)).toBe(true);
    expect(await listBlocked(db, a.id)).toEqual([expect.objectContaining({ userId: b.id })]);

    // followByHandle is null in both directions once blocked
    expect(await followByHandle(db, a.id, "b_taster")).toBeNull();
    expect(await followByHandle(db, b.id, "a_taster")).toBeNull();

    expect(await unblockUser(db, a.id, b.id)).toBe(true);
    expect(await isBlockedEither(db, a.id, b.id)).toBe(false);
  });
});

const TIERS: PourVisibility[] = ["private", "friends", "followers", "public"];

describe("visibility matrix (canViewPour / getSocialNote)", () => {
  let db: DB;
  let owner: schema.User;
  let friend: schema.User;
  let follower: schema.User;
  let stranger: schema.User;
  let blocked: schema.User;
  let bottleId: string;

  beforeEach(async () => {
    db = await setupTestDb();
    owner = await createTestUser(db);
    friend = await createTestUser(db);
    follower = await createTestUser(db);
    stranger = await createTestUser(db);
    blocked = await createTestUser(db);
    const bottle = await createTestBottle(db);
    bottleId = bottle.id;

    await claim(db, owner, "owner_t", { isPublic: true });
    await claim(db, friend, "friend_t", { isPublic: true });
    await claim(db, follower, "follower_t", { isPublic: true });
    await claim(db, stranger, "stranger_t", { isPublic: true });
    await claim(db, blocked, "blocked_t", { isPublic: true });

    // friend: mutual accepted follow with owner
    await followByHandle(db, owner.id, "friend_t");
    await followByHandle(db, friend.id, "owner_t");
    // follower: follows owner, owner does not follow back
    await followByHandle(db, follower.id, "owner_t");
    // blocked: owner blocks them
    await blockUser(db, owner.id, blocked.id);
  });

  it.each(TIERS)("visibility=%s", async (visibility) => {
    const pour = await insertPour(db, owner.id, bottleId, { visibility, rating: 4 });
    await insertNote(db, pour.id, { freeform: "tasting note", flavorTags: { vanilla: 2 } });

    const expected: Record<string, boolean> = {
      owner: true,
      friend: visibility === "friends" || visibility === "followers" || visibility === "public",
      follower: visibility === "followers" || visibility === "public",
      stranger: visibility === "public",
      blocked: false,
      signedOut: false,
    };

    expect(await canViewPour(db, owner.id, pour.id)).toBe(expected.owner);
    expect(await canViewPour(db, friend.id, pour.id)).toBe(expected.friend);
    expect(await canViewPour(db, follower.id, pour.id)).toBe(expected.follower);
    expect(await canViewPour(db, stranger.id, pour.id)).toBe(expected.stranger);
    expect(await canViewPour(db, blocked.id, pour.id)).toBe(expected.blocked);
    expect(await canViewPour(db, null, pour.id)).toBe(expected.signedOut);

    for (const [viewerId, ok] of [
      [owner.id, expected.owner],
      [friend.id, expected.friend],
      [follower.id, expected.follower],
      [stranger.id, expected.stranger],
      [blocked.id, expected.blocked],
      [null, expected.signedOut],
    ] as const) {
      const note = await getSocialNote(db, viewerId, pour.id);
      expect(note !== null).toBe(ok);
    }
  });

  it("hides everything cross-user when the author has socialEnabled=false", async () => {
    await updateProfile(db, owner.id, {}); // no-op sanity
    await db.update(schema.userProfiles).set({ socialEnabled: false }).where(eq(schema.userProfiles.userId, owner.id));
    const pour = await insertPour(db, owner.id, bottleId, { visibility: "public", rating: 5 });
    expect(await canViewPour(db, friend.id, pour.id)).toBe(false);
    expect(await canViewPour(db, stranger.id, pour.id)).toBe(false);
    // Owner still sees their own row.
    expect(await canViewPour(db, owner.id, pour.id)).toBe(true);
  });
});

describe("makeEverythingPrivate", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("flips pours, shares, profile, and prefs to private without deleting anything", async () => {
    const owner = await createTestUser(db);
    await claim(db, owner, "owner_t", { isPublic: true, discoverable: true });
    await updateSocialPrefs(db, owner.id, { defaultPourVisibility: "public", allowComments: true });
    const bottle = await createTestBottle(db);
    const pour = await insertPour(db, owner.id, bottle.id, { visibility: "public", rating: 4 });
    const [share] = await db
      .insert(schema.pourShares)
      .values({ id: uid("share"), pourId: pour.id, userId: owner.id, code: uid("code") })
      .returning();

    await makeEverythingPrivate(db, owner.id);

    const reloadedPour = await db.query.pours.findFirst({ where: (p, { eq }) => eq(p.id, pour.id) });
    expect(reloadedPour?.visibility).toBe("private");
    const reloadedShare = await db.query.pourShares.findFirst({ where: (s, { eq }) => eq(s.id, share.id) });
    expect(reloadedShare?.revokedAt).not.toBeNull();
    const profile = await getOwnProfile(db, owner.id);
    expect(profile).toMatchObject({ socialEnabled: false, isPublic: false, discoverable: false });
    const prefs = await getSocialPrefs(db, owner.id);
    expect(prefs.defaultPourVisibility).toBe("private");

    // Nothing deleted.
    expect(reloadedPour).not.toBeNull();
    expect(reloadedShare).not.toBeNull();
    expect(profile).not.toBeNull();
  });
});

describe("getFriendFeed", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("shows only followees' visible pours with a note or rating, newest first, with counts and viewerTags", async () => {
    const viewer = await createTestUser(db);
    const friendUser = await createTestUser(db);
    const strangerUser = await createTestUser(db);
    const blockedUser = await createTestUser(db);
    await claim(db, viewer, "viewer_t", { isPublic: true });
    await claim(db, friendUser, "friend_t", { isPublic: true });
    await claim(db, strangerUser, "stranger_t", { isPublic: true });
    await claim(db, blockedUser, "blocked_t", { isPublic: true });

    await followByHandle(db, viewer.id, "friend_t");
    await followByHandle(db, viewer.id, "blocked_t");
    await blockUser(db, viewer.id, blockedUser.id);
    // not following stranger

    const bottle = await createTestBottle(db);
    // Viewer's own note on the bottle, for viewerTags union.
    const viewerPour = await insertPour(db, viewer.id, bottle.id, { visibility: "private" });
    await insertNote(db, viewerPour.id, { flavorTags: { vanilla: 2, oak: 1 } });
    await db
      .insert(schema.userBottles)
      .values({ id: uid("ub"), userId: viewer.id, bottleId: bottle.id, relationship: "tried" });

    const older = await insertPour(db, friendUser.id, bottle.id, {
      visibility: "public",
      rating: 4,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await insertNote(db, older.id, { freeform: "first note", flavorTags: { vanilla: 3 } });

    const newer = await insertPour(db, friendUser.id, bottle.id, {
      visibility: "public",
      rating: 4.5,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    await insertNote(db, newer.id, { freeform: "second note", flavorTags: { oak: 3 } });

    // No note and no rating -> excluded.
    await insertPour(db, friendUser.id, bottle.id, { visibility: "public" });
    // Private -> excluded even though visible content exists.
    const privatePour = await insertPour(db, friendUser.id, bottle.id, { visibility: "private", rating: 5 });
    await insertNote(db, privatePour.id, { freeform: "hidden" });
    // Stranger not followed -> excluded regardless of visibility.
    const strangerPour = await insertPour(db, strangerUser.id, bottle.id, { visibility: "public", rating: 3 });
    await insertNote(db, strangerPour.id, { freeform: "stranger note" });
    // Blocked followee -> excluded.
    const blockedPour = await insertPour(db, blockedUser.id, bottle.id, { visibility: "public", rating: 2 });
    await insertNote(db, blockedPour.id, { freeform: "blocked note" });

    await cheerPour(db, viewer.id, newer.id);
    await addComment(db, friendUser.id, newer.id, "nice pour");

    const feed = await getFriendFeed(db, viewer.id);
    expect(feed.map((f) => f.pourId)).toEqual([newer.id, older.id]);

    const newerItem = feed[0];
    expect(newerItem.cheersCount).toBe(1);
    expect(newerItem.viewerCheered).toBe(true);
    expect(newerItem.commentCount).toBe(1);
    expect(newerItem.viewerTags).toEqual({ vanilla: 2, oak: 1 });
    expect(newerItem.viewerBottleRelationship).toBe("tried");
    expect(newerItem.viewerTriedBottle).toBe(true);

    const olderItem = feed[1];
    expect(olderItem.cheersCount).toBe(0);
    expect(olderItem.viewerCheered).toBe(false);
  });

  it("returns [] with no followees", async () => {
    const viewer = await createTestUser(db);
    expect(await getFriendFeed(db, viewer.id)).toEqual([]);
  });
});

describe("getFriendNotesForBottle", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("returns one entry per followee, their latest note, visibility+block enforced", async () => {
    const viewer = await createTestUser(db);
    const friendUser = await createTestUser(db);
    await claim(db, viewer, "viewer_t", { isPublic: true });
    await claim(db, friendUser, "friend_t", { isPublic: true });
    await followByHandle(db, viewer.id, "friend_t");

    const bottle = await createTestBottle(db);
    const earlier = await insertPour(db, friendUser.id, bottle.id, {
      visibility: "public",
      rating: 3,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await insertNote(db, earlier.id, { flavorTags: { honey: 1 } });
    const latest = await insertPour(db, friendUser.id, bottle.id, {
      visibility: "public",
      rating: 4.5,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    await insertNote(db, latest.id, { flavorTags: { vanilla: 2 } });

    const notes = await getFriendNotesForBottle(db, viewer.id, bottle.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].pourId).toBe(latest.id);
    expect(notes[0].author.userId).toBe(friendUser.id);
  });
});

describe("cheers", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("is idempotent, rejects self-cheers, and returns null when the pour isn't visible", async () => {
    const owner = await createTestUser(db);
    const stranger = await createTestUser(db);
    await claim(db, owner, "owner_t", { isPublic: true });
    await claim(db, stranger, "reader_t", { isPublic: true });
    const bottle = await createTestBottle(db);
    const hidden = await insertPour(db, owner.id, bottle.id, { visibility: "private", rating: 4 });
    const pour = await insertPour(db, owner.id, bottle.id, { visibility: "public", rating: 4 });

    expect(await cheerPour(db, stranger.id, hidden.id)).toBeNull();
    // Cheers are reader-to-author: the author can't inflate their own count.
    expect(await cheerPour(db, owner.id, pour.id)).toBeNull();

    expect(await cheerPour(db, stranger.id, pour.id)).toEqual({ cheersCount: 1 });
    expect(await cheerPour(db, stranger.id, pour.id)).toEqual({ cheersCount: 1 }); // idempotent
    expect(await uncheerPour(db, stranger.id, pour.id)).toEqual({ cheersCount: 0 });
    expect(await uncheerPour(db, stranger.id, pour.id)).toEqual({ cheersCount: 0 }); // idempotent
  });
});

describe("comments", () => {
  let db: DB;
  let owner: schema.User;
  let commenter: schema.User;
  let pourId: string;

  beforeEach(async () => {
    db = await setupTestDb();
    owner = await createTestUser(db);
    commenter = await createTestUser(db);
    await claim(db, owner, "owner_t", { isPublic: true });
    await claim(db, commenter, "commenter_t", { isPublic: true });
    await followByHandle(db, commenter.id, "owner_t");
    const bottle = await createTestBottle(db);
    const pour = await insertPour(db, owner.id, bottle.id, { visibility: "public", rating: 4 });
    pourId = pour.id;
  });

  it("adds, lists (oldest first), edits within the window, and rejects a reply to a deleted parent", async () => {
    const c1 = await addComment(db, commenter.id, pourId, "  How did you get smoke out of this?  ");
    expect(c1).not.toBeNull();
    expect(c1?.body).toBe("How did you get smoke out of this?"); // trimmed
    const c2 = await addComment(db, owner.id, pourId, "Char level on the barrel, I think");

    const listed = await listComments(db, owner.id, pourId);
    expect(listed?.map((c) => c.id)).toEqual([c1!.id, c2!.id]);
    expect(listed?.[0].canEdit).toBe(false); // viewer is owner, not the comment's author
    expect(listed?.[0].canDelete).toBe(true); // owner may delete anyone's comment on their pour

    const edited = await editComment(db, commenter.id, c1!.id, "edited: char + smoke");
    expect(edited?.body).toBe("edited: char + smoke");
    expect(edited?.editedAt).not.toBeNull();

    // c2 belongs to the pour owner; the other commenter is neither its author nor the pour owner.
    expect(await softDeleteComment(db, commenter.id, c2!.id)).toBe(false);
  });

  it("owner can soft-delete any comment on their pour; tombstone blanks body/author", async () => {
    const c1 = await addComment(db, commenter.id, pourId, "hello");
    expect(await softDeleteComment(db, owner.id, c1!.id)).toBe(true);
    const listed = await listComments(db, commenter.id, pourId);
    expect(listed?.[0]).toMatchObject({ deleted: true, body: null, author: null, canEdit: false, canDelete: false });
  });

  it("respects the edit window", async () => {
    const c1 = await addComment(db, commenter.id, pourId, "hello");
    await db
      .update(schema.comments)
      .set({ createdAt: new Date(Date.now() - COMMENT_EDIT_WINDOW_MS - 1000) })
      .where(eq(schema.comments.id, c1!.id));
    expect(await editComment(db, commenter.id, c1!.id, "too late")).toBeNull();
    const listed = await listComments(db, commenter.id, pourId);
    expect(listed?.[0].canEdit).toBe(false);
  });

  it("rejects addComment when the pour owner has allowComments=false", async () => {
    await updateSocialPrefs(db, owner.id, { allowComments: false });
    expect(await addComment(db, commenter.id, pourId, "hello")).toBeNull();
  });

  it("rejects a reply whose parent is missing, foreign, or deleted", async () => {
    expect(await addComment(db, commenter.id, pourId, "reply", "not-a-real-id")).toBeNull();
    const c1 = await addComment(db, commenter.id, pourId, "top level");
    await softDeleteComment(db, commenter.id, c1!.id);
    expect(await addComment(db, owner.id, pourId, "reply to deleted", c1!.id)).toBeNull();
  });

  it("drops comments from a blocked author but keeps orphaned replies rendering", async () => {
    const c1 = await addComment(db, commenter.id, pourId, "top level");
    const c2 = await addComment(db, owner.id, pourId, "a reply", c1!.id);
    await blockUser(db, owner.id, commenter.id);

    const listed = await listComments(db, owner.id, pourId);
    expect(listed?.map((c) => c.id)).toEqual([c2!.id]);
    expect(listed?.[0].parentId).toBe(c1!.id); // orphaned, but still renders
  });

  /**
   * Commenting is a social act, and nothing used to check the *commenter's*
   * own profile — only the pour author's. An account that had never opted into
   * social could post comments that moderation then could not answer for,
   * because suspension lives on the profile row that does not exist.
   */
  /**
   * Accepting a follow grants a new reader, so it is an exposure-raising write
   * like any other. A suspended account could still do it, and the new
   * follower would find the profile waiting on reinstatement.
   */
  it("refuses to approve a follow while the account is suspended", async () => {
    const fan = await createTestUser(db);
    await db.insert(schema.follows).values({
      id: crypto.randomUUID(),
      followerId: fan.id,
      followeeId: owner.id,
      state: "pending",
    });

    await db
      .update(schema.userProfiles)
      .set({ suspendedAt: new Date(), socialEnabled: false })
      .where(eq(schema.userProfiles.userId, owner.id));
    expect(await approveFollow(db, owner.id, fan.id)).toBe(false);

    // Still pending, not silently accepted.
    const still = await db.query.follows.findFirst({
      where: and(eq(schema.follows.followerId, fan.id), eq(schema.follows.followeeId, owner.id)),
    });
    expect(still?.state).toBe("pending");

    // Reinstated and re-enabled, the same approval works.
    await db
      .update(schema.userProfiles)
      .set({ suspendedAt: null, socialEnabled: true })
      .where(eq(schema.userProfiles.userId, owner.id));
    expect(await approveFollow(db, owner.id, fan.id)).toBe(true);
  });

  it("refuses a comment from an account with no social profile", async () => {
    const stranger = await createTestUser(db);
    expect(await addComment(db, stranger.id, pourId, "hello")).toBeNull();
    // And once they have one, the same call works.
    await db.insert(schema.userProfiles).values({
      userId: stranger.id,
      handle: "stranger",
      displayName: "Stranger",
      socialEnabled: true,
    });
    expect(await addComment(db, stranger.id, pourId, "hello")).not.toBeNull();
  });

  it("createReport records a report, absorbs duplicates, and rejects fabricated subjects", async () => {
    const c1 = await addComment(db, commenter.id, pourId, "spam-ish");
    await expect(
      createReport(db, owner.id, { subjectType: "comment", subjectId: c1!.id, reason: "spam" }),
    ).resolves.toBe(true);
    // Same reporter + same open subject: absorbed, not duplicated.
    await createReport(db, owner.id, { subjectType: "comment", subjectId: c1!.id, reason: "spam again" });
    const rows = await db.select().from(schema.reports);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: "comment", subjectId: c1!.id, reporterId: owner.id, reason: "spam" });
    // The complaint has to carry what it is about. An operator opening this
    // report days later must see what the reporter saw, not whatever the
    // author has since rewritten it to.
    expect(rows[0].subjectSnapshot).toBe("spam-ish");
    // And who to answer for it. The subject can be hard-deleted; the account
    // behind it is what an account-level action needs, so the report carries it.
    expect(rows[0].subjectOwnerId).toBe(commenter.id);
  });

  /**
   * The limiter has to see what the request ahead of it committed. Putting the
   * capture and the limiter in one repeatable-read transaction pinned every
   * waiter's snapshot before the advisory lock — so concurrent reports from
   * one reporter all read a pre-lock view, and both the duplicate check and
   * the hourly count went blind. SOCIAL §11 requires the queue not be
   * floodable, so this is the property that has to hold.
   */
  it("createReport still limits a reporter firing several at once", async () => {
    const c = await addComment(db, commenter.id, pourId, "spam-ish");

    // The same subject, concurrently: exactly one report, not five.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        createReport(db, owner.id, { subjectType: "comment", subjectId: c!.id, reason: "spam" }),
      ),
    );
    const forSubject = await db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.subjectId, c!.id));
    expect(forSubject).toHaveLength(1);
    // And the snapshot survived the split into two transactions.
    expect(forSubject[0].subjectSnapshot).toBe("spam-ish");
    // A stepped-back author's comment is not reportable either, because
    // `listComments` already stopped showing it — the report path checked the
    // pour and the block relationship but not this, so a stale id could pull a
    // withdrawn comment's current body into the queue as evidence.
    const c3 = await addComment(db, commenter.id, pourId, "was visible");
    await db
      .update(schema.userProfiles)
      .set({ socialEnabled: false })
      .where(eq(schema.userProfiles.userId, commenter.id));
    await expect(
      createReport(db, owner.id, { subjectType: "comment", subjectId: c3!.id, reason: "spam" }),
    ).resolves.toBe(false);
    await db
      .update(schema.userProfiles)
      .set({ socialEnabled: true })
      .where(eq(schema.userProfiles.userId, commenter.id));

    // Nor a deleted one: `listComments` returns `body: null` for a tombstone,
    // to everybody including its author, so there is nothing anyone could have
    // read and nothing left to moderate — capturing the row's body anyway
    // would put text no reporter ever saw into the queue as their evidence.
    const c4 = await addComment(db, commenter.id, pourId, "then deleted");
    await db
      .update(schema.comments)
      .set({ deletedAt: new Date() })
      .where(eq(schema.comments.id, c4!.id));
    await expect(
      createReport(db, owner.id, { subjectType: "comment", subjectId: c4!.id, reason: "spam" }),
    ).resolves.toBe(false);

    // A fabricated subject never reaches the queue.
    await expect(
      createReport(db, owner.id, { subjectType: "pour", subjectId: "no-such-pour", reason: "spam" }),
    ).resolves.toBe(false);
    expect(await db.select().from(schema.reports)).toHaveLength(1);
  });
});

describe("getPalateCard / getProfileView", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("getPalateCard is null-heat with zero sample size, and reports bounded region/style sets", async () => {
    const user = await createTestUser(db);
    const empty = await getPalateCard(db, user.id);
    expect(empty.wheelHeat).toBeNull();
    expect(empty.regionsCovered).toEqual([]);

    const bottle = await createTestBottle(db, {
      country: "Scotland",
      region: "Speyside",
      category: "scotch-single-malt",
    });
    const pour = await insertPour(db, user.id, bottle.id, { rating: 4.5 });
    await insertNote(db, pour.id, { flavorTags: { vanilla: 3, honey: 2 } });
    await db
      .insert(schema.userBottles)
      .values({ id: uid("ub"), userId: user.id, bottleId: bottle.id, relationship: "tried" });

    const card = await getPalateCard(db, user.id);
    expect(card.wheelHeat).not.toBeNull();
    expect(card.countriesCovered).toEqual(["Scotland"]);
    expect(card.regionsCovered).toEqual(["Speyside"]);
    expect(card.stylesCovered).toEqual(["scotch-single-malt"]);
    expect(card.signatureLeafIds.length).toBeGreaterThan(0);
  });

  it("getProfileView returns identity + viewerState, full palate/notes for a viewable profile", async () => {
    const owner = await createTestUser(db, { name: "Sarah" });
    await claim(db, owner, "sarah_t", { isPublic: true, bio: "Peat and salt" });
    const bottle = await createTestBottle(db);
    const pour = await insertPour(db, owner.id, bottle.id, { visibility: "public", rating: 4.5 });
    await insertNote(db, pour.id, { freeform: "campfire", flavorTags: { peat: 3 } });

    const viewer = await createTestUser(db);
    const view = await getProfileView(db, viewer.id, "sarah_t");
    expect(view?.profile.handle).toBe("sarah_t");
    expect(view?.viewerState).toEqual({ isSelf: false, followState: null, followsYou: false, blocked: false });
    expect(view?.recentNotes).toHaveLength(1);
    expect((view?.recentNotes[0] as SocialNote).pourId).toBe(pour.id);
  });

  it("returns identity-only with empty palate/notes for a private profile viewed by a non-follower", async () => {
    const owner = await createTestUser(db);
    await claim(db, owner, "private_t", { isPublic: false });
    const bottle = await createTestBottle(db);
    const pour = await insertPour(db, owner.id, bottle.id, { visibility: "public", rating: 4 });
    await insertNote(db, pour.id, { freeform: "hello" });

    const viewer = await createTestUser(db);
    const view = await getProfileView(db, viewer.id, "private_t");
    expect(view?.profile.handle).toBe("private_t");
    expect(view?.palate).toEqual({
      wheelHeat: null,
      signatureLeafIds: [],
      countriesCovered: [],
      regionsCovered: [],
      stylesCovered: [],
    });
    expect(view?.recentNotes).toEqual([]);
  });

  it("signed-out viewer gets identity-only even for a public profile", async () => {
    const owner = await createTestUser(db);
    await claim(db, owner, "public_t", { isPublic: true });
    const bottle = await createTestBottle(db);
    const pour = await insertPour(db, owner.id, bottle.id, { visibility: "public", rating: 4 });
    await insertNote(db, pour.id, { freeform: "hello" });

    const view = await getProfileView(db, null, "public_t");
    expect(view?.recentNotes).toEqual([]);
    expect(view?.palate.wheelHeat).toBeNull();
  });

  it("returns null for a missing handle or a socially-disabled/blocked profile", async () => {
    expect(await getProfileView(db, null, "nobody")).toBeNull();

    const owner = await createTestUser(db);
    await claim(db, owner, "off_t", { socialEnabled: false });
    expect(await getProfileView(db, null, "off_t")).toBeNull();

    const viewer = await createTestUser(db);
    const blockedOwner = await createTestUser(db);
    await claim(db, blockedOwner, "blocked_owner_t", { isPublic: true });
    await blockUser(db, blockedOwner.id, viewer.id);
    expect(await getProfileView(db, viewer.id, "blocked_owner_t")).toBeNull();
  });
});

describe("money/volume guard", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("never serializes purchasePrice, estValue, or amountMl on any cross-user shape", async () => {
    const owner = await createTestUser(db);
    const viewer = await createTestUser(db);
    await claim(db, owner, "owner_t", { isPublic: true });
    await claim(db, viewer, "viewer_t", { isPublic: true });
    await followByHandle(db, viewer.id, "owner_t");

    const bottle = await createTestBottle(db);
    const [ub] = await db
      .insert(schema.userBottles)
      .values({
        id: uid("ub"),
        userId: owner.id,
        bottleId: bottle.id,
        relationship: "own",
        purchasePrice: 199.99,
        estValue: 250,
      })
      .returning();
    const pour = await insertPour(db, owner.id, bottle.id, {
      visibility: "public",
      rating: 4,
      amountMl: 45,
      userBottleId: ub.id,
    });
    await insertNote(db, pour.id, { freeform: "note" });

    const note = await getSocialNote(db, viewer.id, pour.id);
    const feed = await getFriendFeed(db, viewer.id);
    const view = await getProfileView(db, viewer.id, "owner_t");

    for (const serialized of [JSON.stringify(note), JSON.stringify(feed), JSON.stringify(view)]) {
      expect(serialized).not.toMatch(/purchasePrice/i);
      expect(serialized).not.toMatch(/estValue/i);
      expect(serialized).not.toMatch(/amountMl/i);
      expect(serialized).not.toContain("199.99");
    }
  });
});

describe("review-pass hardening", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  async function mutualFollow(a: schema.User, b: schema.User, aHandle: string, bHandle: string) {
    await claim(db, a, aHandle, { isPublic: true });
    await claim(db, b, bHandle, { isPublic: true });
    await followByHandle(db, a.id, bHandle);
    await followByHandle(db, b.id, aHandle);
  }

  it("a stepped-back user's comments, cheers, and graph rows vanish for others but not for themself", async () => {
    const viewer = await createTestUser(db);
    const stepped = await createTestUser(db);
    const bottle = await createTestBottle(db);
    await mutualFollow(viewer, stepped, "viewer_sb", "stepped_sb");

    const pour = await insertPour(db, viewer.id, bottle.id, { visibility: "public", rating: 4 });
    await insertNote(db, pour.id, { freeform: "mine" });
    await addComment(db, stepped.id, pour.id, "was here");
    await cheerPour(db, stepped.id, pour.id);

    // Sanity before stepping back: contribution and graph rows are visible.
    expect((await listComments(db, viewer.id, pour.id))!.some((c) => c.author?.userId === stepped.id)).toBe(true);
    expect((await getSocialNote(db, viewer.id, pour.id))!.cheersCount).toBe(1);

    await makeEverythingPrivate(db, stepped.id);

    const comments = await listComments(db, viewer.id, pour.id);
    expect(comments!.some((c) => c.author?.userId === stepped.id)).toBe(false);
    // Counts agree with the visible thread — no hidden-activity leak.
    const ownNote = await getSocialNote(db, viewer.id, pour.id);
    expect(ownNote!.cheersCount).toBe(0);
    expect(ownNote!.commentCount).toBe(0);
    expect(await listFollowing(db, viewer.id)).toHaveLength(0);
    expect(await listFollowers(db, viewer.id)).toHaveLength(0);

    // The stepped-back user still sees their own comment (nothing deleted).
    const own = await listComments(db, stepped.id, pour.id);
    expect(own!.some((c) => c.author?.userId === stepped.id)).toBe(true);
  });

  it("Same Dram picks a friend's latest NOTED pour, not a newer note-less one", async () => {
    const viewer = await createTestUser(db);
    const friend = await createTestUser(db);
    const bottle = await createTestBottle(db);
    await mutualFollow(viewer, friend, "viewer_sd", "friend_sd");

    const noted = await insertPour(db, friend.id, bottle.id, {
      visibility: "friends",
      rating: 4,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    await insertNote(db, noted.id, { flavorTags: { vanilla: 3 } });
    await insertPour(db, friend.id, bottle.id, {
      visibility: "friends",
      rating: 3,
      createdAt: new Date("2026-07-10T00:00:00Z"),
    });

    const rows = await getFriendNotesForBottle(db, viewer.id, bottle.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].pourId).toBe(noted.id);
    expect(rows[0].flavorTags).toEqual({ vanilla: 3 });
  });

  it("comment writes are rate-limited per hour", async () => {
    const owner = await createTestUser(db);
    const commenter = await createTestUser(db);
    const bottle = await createTestBottle(db);
    await mutualFollow(owner, commenter, "owner_rl", "commenter_rl");
    const pour = await insertPour(db, owner.id, bottle.id, { visibility: "public", rating: 4 });
    await insertNote(db, pour.id, { freeform: "note" });

    for (let i = 0; i < COMMENT_RATE_LIMIT_PER_HOUR; i += 1) {
      const created = await addComment(db, commenter.id, pour.id, `c${i}`);
      expect(created).not.toBeNull();
    }
    await expect(addComment(db, commenter.id, pour.id, "one too many")).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("codex round-2 hardening", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("rejects link-like bios but keeps ordinary prose", () => {
    for (const bad of ["see https://mysite.com", "www.whisky.bar", "buy at whiskydeals.com now"]) {
      expect(profileCreateSchema.safeParse({ handle: "abc", bio: bad }).success).toBe(false);
      expect(profileUpdateSchema.safeParse({ bio: bad }).success).toBe(false);
    }
    for (const ok of ["Islay obsessive, chasing peat smoke since 2019.", "Portland, OR", "Mr. Peat"]) {
      expect(profileCreateSchema.safeParse({ handle: "abc", bio: ok }).success).toBe(true);
    }
  });

  it("patches only the supplied pref columns", async () => {
    const user = await createTestUser(db);
    await updateSocialPrefs(db, user.id, { defaultPourVisibility: "friends" });
    const after = await updateSocialPrefs(db, user.id, { allowComments: false });
    expect(after).toEqual({ defaultPourVisibility: "friends", allowComments: false });
  });

  it("older public notes still surface on a profile behind newer private pours", async () => {
    const viewer = await createTestUser(db);
    const author = await createTestUser(db);
    await claim(db, viewer, "viewer_pn", { isPublic: true });
    await claim(db, author, "author_pn", { isPublic: true });
    const bottle = await createTestBottle(db);

    const publicPour = await insertPour(db, author.id, bottle.id, {
      visibility: "public",
      rating: 5,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await insertNote(db, publicPour.id, { freeform: "the good one" });
    for (let i = 0; i < 20; i += 1) {
      const p = await insertPour(db, author.id, bottle.id, {
        visibility: "private",
        rating: 3,
        createdAt: new Date(`2026-03-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
      });
      await insertNote(db, p.id, { freeform: `private ${i}` });
    }

    const view = await getProfileView(db, viewer.id, "author_pn");
    expect(view!.recentNotes).toHaveLength(1);
    expect(view!.recentNotes[0].pourId).toBe(publicPour.id);
  });
});

describe("codex round-5 hardening", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("profile note slots are reserved for pours with tasting notes", async () => {
    const viewer = await createTestUser(db);
    const author = await createTestUser(db);
    await claim(db, viewer, "viewer_ns", { isPublic: true });
    await claim(db, author, "author_ns", { isPublic: true });
    const bottle = await createTestBottle(db);

    const noted = await insertPour(db, author.id, bottle.id, {
      visibility: "public",
      rating: 4,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await insertNote(db, noted.id, { freeform: "actual words" });
    for (let i = 0; i < 3; i += 1) {
      await insertPour(db, author.id, bottle.id, {
        visibility: "public",
        rating: 3,
        createdAt: new Date(`2026-02-0${i + 1}T00:00:00Z`),
      });
    }

    const view = await getProfileView(db, viewer.id, "author_ns");
    expect(view!.recentNotes).toHaveLength(1);
    expect(view!.recentNotes[0].pourId).toBe(noted.id);
  });

  it("follow lists never show a blocked pair, even if an edge row survives", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    await claim(db, a, "a_bl", { isPublic: true });
    await claim(db, b, "b_bl", { isPublic: true });
    await followByHandle(db, a.id, "b_bl");
    await followByHandle(db, b.id, "a_bl");
    await blockUser(db, a.id, b.id);
    // Simulate a follow insert that raced the block's edge deletion.
    await db.insert(schema.follows).values({
      id: uid("follow"),
      followerId: a.id,
      followeeId: b.id,
      state: "accepted",
    });
    expect(await listFollowing(db, a.id)).toHaveLength(0);
    expect(await listFollowers(db, b.id)).toHaveLength(0);
  });
});

describe("phone discovery", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("setPhone requires an existing profile — null otherwise", async () => {
    const user = await createTestUser(db);
    expect(await setPhone(db, user.id, "415-555-0123", true)).toBeNull();
  });

  it("setPhone normalizes+hashes: the raw number is never stored, only the hash + last 2", async () => {
    const user = await createTestUser(db);
    await claim(db, user, "phoneowner");

    const result = await setPhone(db, user.id, "(415) 555-0123", false);
    expect(result).toEqual({ phoneLast2: "23", phoneDiscoverable: false });

    const profile = await getOwnProfile(db, user.id);
    expect(profile?.userId).toBeDefined();
    const row = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, user.id) });
    expect(row?.phoneHash).toBeTruthy();
    expect(row?.phoneHash).not.toContain("4155550123");
    expect(row?.phoneHash).not.toBe("(415) 555-0123");
    expect(row?.phoneLast2).toBe("23");
  });

  it("setPhone rejects a malformed number with InvalidPhoneError", async () => {
    const user = await createTestUser(db);
    await claim(db, user, "phoneowner2");
    await expect(setPhone(db, user.id, "not a phone", false)).rejects.toBeInstanceOf(InvalidPhoneError);
  });

  it("setPhone throws PhoneTakenError when another account already holds the number", async () => {
    const first = await createTestUser(db);
    const second = await createTestUser(db);
    await claim(db, first, "firstphone");
    await claim(db, second, "secondphone");

    await setPhone(db, first.id, "4155550123", false);
    await expect(setPhone(db, second.id, "4155550123", false)).rejects.toBeInstanceOf(PhoneTakenError);
  });

  it("setPhone lets a user re-save their own already-claimed number without a false PhoneTakenError", async () => {
    const user = await createTestUser(db);
    await claim(db, user, "resaver");
    await setPhone(db, user.id, "4155550123", false);
    await expect(setPhone(db, user.id, "4155550123", true)).resolves.toEqual({
      phoneLast2: "23",
      phoneDiscoverable: true,
    });
  });

  it("setPhone with discoverable=true while stepped back throws SocialDisabledError; discoverable=false is always allowed", async () => {
    const user = await createTestUser(db);
    await claim(db, user, "steppedback", { socialEnabled: false });

    await expect(setPhone(db, user.id, "4155550123", true)).rejects.toBeInstanceOf(SocialDisabledError);
    await expect(setPhone(db, user.id, "4155550123", false)).resolves.toEqual({
      phoneLast2: "23",
      phoneDiscoverable: false,
    });
  });

  it("clearPhone removes the number and turns discoverability off; false when there's no profile", async () => {
    const noProfile = await createTestUser(db);
    expect(await clearPhone(db, noProfile.id)).toBe(false);

    const user = await createTestUser(db);
    await claim(db, user, "clearme");
    await setPhone(db, user.id, "4155550123", true);
    expect(await clearPhone(db, user.id)).toBe(true);

    const row = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, user.id) });
    expect(row?.phoneHash).toBeNull();
    expect(row?.phoneLast2).toBeNull();
    expect(row?.phoneDiscoverable).toBe(false);
  });

  it("setPhoneDiscoverable flips the flag; true while stepped back throws SocialDisabledError", async () => {
    const user = await createTestUser(db);
    await claim(db, user, "flipper");
    await setPhone(db, user.id, "4155550123", false);

    expect(await setPhoneDiscoverable(db, user.id, true)).toBe(true);
    let row = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, user.id) });
    expect(row?.phoneDiscoverable).toBe(true);

    expect(await setPhoneDiscoverable(db, user.id, false)).toBe(true);
    row = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, user.id) });
    expect(row?.phoneDiscoverable).toBe(false);

    await db.update(schema.userProfiles).set({ socialEnabled: false }).where(eq(schema.userProfiles.userId, user.id));
    await expect(setPhoneDiscoverable(db, user.id, true)).rejects.toBeInstanceOf(SocialDisabledError);
    await expect(setPhoneDiscoverable(db, user.id, false)).resolves.toBe(true);
  });

  it("setPhoneDiscoverable returns false when there's no profile", async () => {
    const user = await createTestUser(db);
    expect(await setPhoneDiscoverable(db, user.id, true)).toBe(false);
  });

  it("findProfileByPhone: opt-in matrix — no number, not discoverable, stepped back, blocked, and the happy path", async () => {
    const viewer = await createTestUser(db);
    await claim(db, viewer, "phoneviewer");

    const noNumber = await createTestUser(db);
    await claim(db, noNumber, "nonumber");
    expect(await findProfileByPhone(db, viewer.id, "4155550001")).toBeNull();

    const notDiscoverable = await createTestUser(db);
    await claim(db, notDiscoverable, "notdiscoverable");
    await setPhone(db, notDiscoverable.id, "4155550002", false);
    expect(await findProfileByPhone(db, viewer.id, "4155550002")).toBeNull();

    const steppedBack = await createTestUser(db);
    await claim(db, steppedBack, "steppedbackphone");
    await setPhone(db, steppedBack.id, "4155550003", true);
    await db.update(schema.userProfiles).set({ socialEnabled: false }).where(eq(schema.userProfiles.userId, steppedBack.id));
    expect(await findProfileByPhone(db, viewer.id, "4155550003")).toBeNull();

    const blocked = await createTestUser(db);
    await claim(db, blocked, "blockedphone");
    await setPhone(db, blocked.id, "4155550004", true);
    await blockUser(db, viewer.id, blocked.id);
    expect(await findProfileByPhone(db, viewer.id, "4155550004")).toBeNull();

    const findable = await createTestUser(db);
    await claim(db, findable, "findableuser");
    await setPhone(db, findable.id, "4155550005", true);
    const match = await findProfileByPhone(db, viewer.id, "4155550005");
    expect(match).toEqual({
      userId: findable.id,
      handle: "findableuser",
      displayName: expect.any(String),
      avatarUrl: null,
    });
  });

  it("findProfileByPhone throws InvalidPhoneError for a malformed number", async () => {
    const viewer = await createTestUser(db);
    await claim(db, viewer, "invalidlookup");
    await expect(findProfileByPhone(db, viewer.id, "abc")).rejects.toBeInstanceOf(InvalidPhoneError);
  });

  it("findProfileByPhone durably rate-limits at 21 lookups/hour, counting misses toward the limit", async () => {
    const viewer = await createTestUser(db);
    await claim(db, viewer, "ratelimited");

    for (let i = 0; i < PHONE_LOOKUP_LIMIT_PER_HOUR; i += 1) {
      // Every one of these is a miss — misses count toward the limit too (the
      // enumeration guard), so the 20 misses alone exhaust it.
      expect(await findProfileByPhone(db, viewer.id, `415555${String(9000 + i)}`)).toBeNull();
    }
    await expect(findProfileByPhone(db, viewer.id, "4155559999")).rejects.toBeInstanceOf(RateLimitedError);

    const rows = await db.query.phoneLookups.findMany({ where: eq(schema.phoneLookups.userId, viewer.id) });
    expect(rows).toHaveLength(PHONE_LOOKUP_LIMIT_PER_HOUR);
  });

  it("setPhone draws from the same probe budget — saving candidates can't out-enumerate the lookup limit", async () => {
    const user = await createTestUser(db);
    await claim(db, user, "probesaver");

    for (let i = 0; i < PHONE_LOOKUP_LIMIT_PER_HOUR; i += 1) {
      expect(await findProfileByPhone(db, user.id, `415555${String(9000 + i)}`)).toBeNull();
    }
    // The exhausted budget blocks set attempts too: posting candidates with
    // discoverable=false would otherwise read "phone_taken vs success" as an
    // unmetered registered-number oracle that ignores discoverability.
    await expect(setPhone(db, user.id, "4155550123", false)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("each permitted probe sweeps rows that aged out of the rate window", async () => {
    const user = await createTestUser(db);
    await claim(db, user, "sweeper");

    await db.insert(schema.phoneLookups).values({
      id: crypto.randomUUID(),
      userId: user.id,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    expect(await findProfileByPhone(db, user.id, "4155550001")).toBeNull();

    const rows = await db.query.phoneLookups.findMany({ where: eq(schema.phoneLookups.userId, user.id) });
    // Only the probe just recorded survives — the expired row no longer
    // counted toward the limit and is gone rather than accumulating forever.
    expect(rows).toHaveLength(1);
  });
});

describe("getAddTarget", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("returns null for a missing handle", async () => {
    const viewer = await createTestUser(db);
    await claim(db, viewer, "addviewer1");
    expect(await getAddTarget(db, viewer.id, "ghost")).toBeNull();
  });

  it("returns null when the target has socialEnabled=false", async () => {
    const viewer = await createTestUser(db);
    await claim(db, viewer, "addviewer2");
    const target = await createTestUser(db);
    await claim(db, target, "steppedbacktarget", { socialEnabled: false });
    expect(await getAddTarget(db, viewer.id, "steppedbacktarget")).toBeNull();
  });

  it("returns null when either party has blocked the other", async () => {
    const viewer = await createTestUser(db);
    await claim(db, viewer, "addviewer3");
    const target = await createTestUser(db);
    await claim(db, target, "addtarget3");
    await blockUser(db, viewer.id, target.id);
    expect(await getAddTarget(db, viewer.id, "addtarget3")).toBeNull();

    const target2 = await createTestUser(db);
    await claim(db, target2, "addtarget3b");
    await blockUser(db, target2.id, viewer.id);
    expect(await getAddTarget(db, viewer.id, "addtarget3b")).toBeNull();
  });

  it("isSelf is allowed through and flagged", async () => {
    const user = await createTestUser(db);
    await claim(db, user, "addself");
    const result = await getAddTarget(db, user.id, "addself");
    expect(result).toMatchObject({ isSelf: true, followState: null, followsYou: false });
    expect(result?.profile.handle).toBe("addself");
  });

  it("returns identity + follow state for a reachable target", async () => {
    const viewer = await createTestUser(db);
    await claim(db, viewer, "addviewer4", { isPublic: true });
    const target = await createTestUser(db);
    await claim(db, target, "addtarget4", { isPublic: true });

    const before = await getAddTarget(db, viewer.id, "addtarget4");
    expect(before).toMatchObject({ isSelf: false, followState: null, followsYou: false, isPublic: true });

    await followByHandle(db, viewer.id, "addtarget4");
    await followByHandle(db, target.id, "addviewer4");

    const after = await getAddTarget(db, viewer.id, "addtarget4");
    expect(after?.followState).toBe("accepted");
    expect(after?.followsYou).toBe(true);
  });
});

describe("privacy reset clears phone discovery", () => {
  it("makeEverythingPrivate flips phoneDiscoverable off; re-enable does not restore it", async () => {
    const db = await setupTestDb();
    const user = await createTestUser(db);
    await claim(db, user, "phone_reset", { isPublic: true });
    await setPhone(db, user.id, "+15551230099", true);

    await makeEverythingPrivate(db, user.id);
    let profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, user.id),
    });
    expect(profile?.phoneDiscoverable).toBe(false);
    // The number itself is kept (nothing deleted) — only discovery is off.
    expect(profile?.phoneHash).not.toBeNull();

    const { setSocialEnabled } = await import("@/lib/social");
    await setSocialEnabled(db, user.id, true);
    profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, user.id),
    });
    expect(profile?.phoneDiscoverable).toBe(false);
  });
});

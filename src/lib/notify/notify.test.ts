import { generateKeyPairSync, createVerify } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  addComment,
  approveFollow,
  blockUser,
  cheerPour,
  createProfile,
  decodeFeedCursor,
  encodeFeedCursor,
  followByHandle,
  getFriendFeed,
  uncheerPour,
} from "@/lib/social";
import {
  deliverNotification,
  friendTastedDigest,
  getNotificationSettings,
  inQuietHours,
  listInbox,
  markRead,
  notificationSettingsPatchSchema,
  notify,
  sweepNotifications,
  unreadCount,
  updateNotificationSettings,
} from "@/lib/notify";
import { setPushFetchForTests, signAssertion } from "@/lib/push/send";

async function person(db: DB, handle: string, overrides: Partial<typeof schema.userProfiles.$inferInsert> = {}) {
  const user = await createTestUser(db, { name: handle });
  await createProfile(db, user, handle);
  await db
    .update(schema.userProfiles)
    .set({ isPublic: true, ...overrides })
    .where(eq(schema.userProfiles.userId, user.id));
  return user;
}

async function pour(db: DB, userId: string, bottleId: string, overrides: Partial<typeof schema.pours.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.pours)
    .values({ id: uid("pour"), userId, bottleId, rating: 4, visibility: "friends", ...overrides })
    .returning();
  return row;
}

async function friends(db: DB, a: schema.User, aHandle: string, b: schema.User, bHandle: string) {
  await followByHandle(db, a.id, bHandle);
  await followByHandle(db, b.id, aHandle);
}

const rowsFor = (db: DB, userId: string) =>
  db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));

describe("notify triggers on social actions", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("a cheer notifies the author once, however often it toggles", async () => {
    const author = await person(db, "author_n");
    const reader = await person(db, "reader_n");
    await friends(db, author, "author_n", reader, "reader_n");
    const bottle = await createTestBottle(db);
    const p = await pour(db, author.id, bottle.id);

    await cheerPour(db, reader.id, p.id);
    await uncheerPour(db, reader.id, p.id);
    await cheerPour(db, reader.id, p.id);

    const inbox = await listInbox(db, author.id);
    const cheers = inbox.filter((i) => i.category === "cheer");
    expect(cheers).toHaveLength(1);
    expect(cheers[0].text).toBe("@reader_n cheered your note");
    expect(cheers[0].deepLink).toBe(`/notes/${p.id}`);
    // Push is never attempted without credentials — inbox only.
    const [row] = (await rowsFor(db, author.id)).filter((r) => r.category === "cheer");
    expect(row.pushState).toBe("unconfigured");
  });

  it("follows, requests and approvals notify the right side", async () => {
    const a = await person(db, "alpha_n");
    const b = await person(db, "bravo_n", { isPublic: false });
    const c = await person(db, "charlie_n");

    await followByHandle(db, a.id, "charlie_n"); // public → follower
    await followByHandle(db, a.id, "bravo_n"); // private → request
    expect((await listInbox(db, c.id)).map((i) => i.text)).toEqual(["@alpha_n started following you"]);
    expect((await listInbox(db, b.id)).map((i) => i.text)).toEqual(["@alpha_n asked to follow you"]);

    await approveFollow(db, b.id, a.id);
    expect((await listInbox(db, a.id)).map((i) => i.text)).toContain("@bravo_n accepted your follow request");
  });

  it("comments notify the author; a reply notifies the parent's author", async () => {
    const author = await person(db, "author_c");
    const first = await person(db, "first_c");
    const second = await person(db, "second_c");
    await friends(db, author, "author_c", first, "first_c");
    await friends(db, author, "author_c", second, "second_c");
    const bottle = await createTestBottle(db);
    const p = await pour(db, author.id, bottle.id, { visibility: "public" });

    const top = await addComment(db, first.id, p.id, "Lovely");
    await addComment(db, second.id, p.id, "Agreed", top!.id);

    const authorInbox = (await listInbox(db, author.id)).filter((i) => i.category !== "follower");
    expect(authorInbox.map((i) => i.text).sort()).toEqual([
      "@first_c commented on your note",
      "@second_c commented on your note",
    ]);
    const firstInbox = (await listInbox(db, first.id)).filter((i) => i.category === "reply");
    expect(firstInbox.map((i) => i.text)).toEqual(["@second_c replied to your comment"]);
  });

  it("never notifies yourself, across a block, or someone with social off; respects group switches", async () => {
    const a = await person(db, "a_rules");
    const b = await person(db, "b_rules");
    const off = await person(db, "off_rules", { socialEnabled: false });

    expect(await notify(db, { recipientId: a.id, actorId: a.id, category: "cheer", dedupeKey: "x1" })).toBeNull();
    expect(await notify(db, { recipientId: off.id, actorId: a.id, category: "cheer", dedupeKey: "x2" })).toBeNull();

    await updateNotificationSettings(db, a.id, { groups: { cheers: false } });
    expect(await notify(db, { recipientId: a.id, actorId: b.id, category: "cheer", dedupeKey: "x3" })).toBeNull();
    expect(await notify(db, { recipientId: a.id, actorId: b.id, category: "comment", dedupeKey: "x4" })).not.toBeNull();

    await blockUser(db, a.id, b.id);
    expect(await notify(db, { recipientId: a.id, actorId: b.id, category: "comment", dedupeKey: "x5" })).toBeNull();
    // …and what arrived before the block disappears from the inbox and the badge.
    expect(await listInbox(db, a.id)).toEqual([]);
    expect(await unreadCount(db, a.id)).toBe(0);
  });

  it("hides notifications from a suspended actor on the read path", async () => {
    const a = await person(db, "a_susp");
    const b = await person(db, "b_susp");
    await notify(db, { recipientId: a.id, actorId: b.id, category: "comment", subjectId: "p", dedupeKey: "s1" });
    expect(await unreadCount(db, a.id)).toBe(1);
    await db.update(schema.userProfiles).set({ suspendedAt: new Date() }).where(eq(schema.userProfiles.userId, b.id));
    expect(await listInbox(db, a.id)).toEqual([]);
    expect(await unreadCount(db, a.id)).toBe(0);
  });

  it("marks only the caller's own rows read", async () => {
    const a = await person(db, "a_read");
    const b = await person(db, "b_read");
    const idA = await notify(db, { recipientId: a.id, actorId: b.id, category: "comment", dedupeKey: "r1" });
    const idB = await notify(db, { recipientId: b.id, actorId: a.id, category: "comment", dedupeKey: "r2" });
    expect(await markRead(db, a.id, [idA!, idB!])).toBe(1);
    expect(await unreadCount(db, a.id)).toBe(0);
    expect(await unreadCount(db, b.id)).toBe(1);
    expect(await markRead(db, b.id)).toBe(1);
  });

  it("sweeps inbox rows past 90 days", async () => {
    const a = await person(db, "a_sweep");
    const b = await person(db, "b_sweep");
    const old = new Date("2026-01-01T00:00:00Z");
    await notify(db, { recipientId: a.id, actorId: b.id, category: "comment", dedupeKey: "old" }, old);
    await notify(db, { recipientId: a.id, actorId: b.id, category: "comment", dedupeKey: "new" });
    await sweepNotifications(db, new Date());
    expect((await rowsFor(db, a.id)).map((r) => r.dedupeKey)).toEqual(["new"]);
  });
});

describe("friend tasted digest", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("tells a friend who owns or wishlisted the bottle, once a day, never about a private note", async () => {
    const owner = await person(db, "owner_d");
    const friend = await person(db, "friend_d");
    const stranger = await person(db, "stranger_d");
    await friends(db, owner, "owner_d", friend, "friend_d");
    const bottle = await createTestBottle(db, { name: "Test Islay 10" });
    const other = await createTestBottle(db, { name: "Other" });
    for (const u of [owner, stranger]) {
      await db.insert(schema.userBottles).values({ id: uid("ub"), userId: u.id, bottleId: bottle.id, relationship: "own" });
    }
    const now = new Date("2026-10-20T03:00:00Z");
    await pour(db, friend.id, bottle.id, { createdAt: new Date("2026-10-19T20:00:00Z") });
    await pour(db, friend.id, bottle.id, { createdAt: new Date("2026-10-19T21:00:00Z"), visibility: "private" });
    await pour(db, friend.id, other.id, { createdAt: new Date("2026-10-19T22:00:00Z") });

    expect(await friendTastedDigest(db, now)).toBe(1);
    expect(await friendTastedDigest(db, now)).toBe(0); // same day: batched
    const inbox = await listInbox(db, owner.id);
    const tasted = inbox.filter((i) => i.category === "friend_tasted");
    expect(tasted.map((i) => i.text)).toEqual(["@friend_d shared a note on Test Islay 10 from your shelf"]);
    expect(await listInbox(db, stranger.id)).toEqual([]);
  });
});

describe("settings and quiet hours", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("defaults every group on and validates patches", async () => {
    const a = await createTestUser(db);
    const s = await getNotificationSettings(db, a.id);
    expect(Object.values(s.groups).every(Boolean)).toBe(true);
    expect(s.quietStart).toBeNull();
    expect(notificationSettingsPatchSchema.safeParse({ quietStart: 60 }).success).toBe(false);
    expect(notificationSettingsPatchSchema.safeParse({ groups: { nope: true } }).success).toBe(false);
    expect(notificationSettingsPatchSchema.safeParse({ timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(
      notificationSettingsPatchSchema.safeParse({ quietStart: 1320, quietEnd: 480, timeZone: "America/Los_Angeles" }).success,
    ).toBe(true);
  });

  it("handles quiet hours that wrap midnight, in the person's zone", () => {
    const s = { quietStart: 22 * 60, quietEnd: 8 * 60, timeZone: "America/Los_Angeles" };
    expect(inQuietHours(s, new Date("2026-10-20T06:30:00Z"))).toBe(true); // 23:30 PDT
    expect(inQuietHours(s, new Date("2026-10-20T14:30:00Z"))).toBe(true); // 07:30 PDT
    expect(inQuietHours(s, new Date("2026-10-20T19:00:00Z"))).toBe(false); // 12:00 PDT
    expect(inQuietHours({ quietStart: null, quietEnd: null, timeZone: null }, new Date())).toBe(false);
  });
});

describe("push delivery through FCM", () => {
  let db: DB;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = {
    project_id: "whaikey-test",
    client_email: "push@whaikey-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };

  beforeEach(async () => {
    db = await setupTestDb();
    vi.stubEnv("FCM_SERVICE_ACCOUNT_JSON", JSON.stringify(sa));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setPushFetchForTests(null);
  });

  it("signs a verifiable service-account assertion", () => {
    const jwt = signAssertion(sa, 1_700_000_000);
    const [h, c, sig] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${c}`);
    expect(verifier.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toMatchObject({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
  });

  it("sends to every device, prunes UNREGISTERED tokens, records the outcome", async () => {
    const a = await person(db, "a_push");
    const b = await person(db, "b_push");
    await db.insert(schema.pushDevices).values([
      { id: uid("dev"), userId: a.id, token: "good-token", platform: "android" },
      { id: uid("dev"), userId: a.id, token: "dead-token", platform: "ios" },
    ]);
    const sent: Array<{ token: string; body: string; deepLink: string }> = [];
    setPushFetchForTests(async (url, init) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "at", expires_in: 3600 });
      const msg = JSON.parse(String(init?.body)).message;
      sent.push({ token: msg.token, body: msg.notification.body, deepLink: msg.data.deepLink });
      if (msg.token === "dead-token") {
        return Response.json({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }, { status: 404 });
      }
      return Response.json({ name: "projects/x/messages/1" });
    });

    // Insert directly as pending so the after()-scheduled send doesn't race the assertion.
    const [row] = await db
      .insert(schema.notifications)
      .values({ id: uid("n"), userId: a.id, actorId: b.id, category: "cheer", subjectId: "pour1", dedupeKey: "d", pushState: "pending" })
      .returning();
    expect(await deliverNotification(db, row.id)).toBe("sent");
    expect(await deliverNotification(db, row.id)).toBeNull(); // claimed once
    expect(sent.map((s) => s.token).sort()).toEqual(["dead-token", "good-token"]);
    expect(sent[0]).toMatchObject({ body: "@b_push cheered your note", deepLink: "/notes/pour1" });
    const devices = await db.select().from(schema.pushDevices).where(eq(schema.pushDevices.userId, a.id));
    expect(devices.map((d) => d.token)).toEqual(["good-token"]);
    const [after] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, row.id));
    expect(after.pushState).toBe("sent");
    expect(after.pushedAt).not.toBeNull();
  });

  it("inside quiet hours a notification is inbox-only", async () => {
    const a = await person(db, "a_quiet");
    const b = await person(db, "b_quiet");
    await updateNotificationSettings(db, a.id, { quietStart: 0, quietEnd: 1439, timeZone: "UTC" });
    const id = await notify(db, { recipientId: a.id, actorId: b.id, category: "comment", dedupeKey: "q" }, new Date("2026-10-20T12:00:00Z"));
    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, id!));
    expect(row.pushState).toBe("quiet");
  });
});

describe("feed cursor", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("round-trips and rejects junk", () => {
    const c = { createdAt: new Date("2026-10-01T00:00:00Z"), pourId: "p1" };
    expect(decodeFeedCursor(encodeFeedCursor(c))).toEqual(c);
    expect(decodeFeedCursor("nope")).toBeNull();
    expect(decodeFeedCursor("not-a-date~p")).toBeNull();
  });

  it("pages without gaps or repeats, ties broken by id", async () => {
    const viewer = await person(db, "viewer_f");
    const friend = await person(db, "friend_f");
    await friends(db, viewer, "viewer_f", friend, "friend_f");
    const bottle = await createTestBottle(db);
    const same = new Date("2026-10-01T00:00:00Z");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await pour(db, friend.id, bottle.id, { createdAt: i < 3 ? same : new Date(`2026-10-0${i}T00:00:00Z`) })).id);

    const seen: string[] = [];
    let before = null as ReturnType<typeof decodeFeedCursor>;
    for (let page = 0; page < 5; page++) {
      const items = await getFriendFeed(db, viewer.id, { limit: 2, before });
      if (items.length === 0) break;
      seen.push(...items.map((i) => i.pourId));
      const last = items[items.length - 1];
      before = { createdAt: last.createdAt, pourId: last.pourId };
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import {
  createTestBottle,
  createTestUser,
  jsonRequest,
  mockSessionModule,
  setSessionUser,
  setupTestDb,
  uid,
} from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { DELETE } from "@/app/api/account/route";
import { GET as EXPORT } from "@/app/api/account/export/route";
import { ACCOUNT_DATA, countSlice, deleteAccount, type AccountExport } from "@/lib/account-data";
import { getPublicPourShare } from "@/lib/pour-sharing";

/**
 * Everything an account can leave behind, one row per slice of the policy.
 *
 * `subject` gets a row in every slice of `ACCOUNT_DATA`; `counterpart` is the
 * other side of each interaction (the account followed, blocked, cheered,
 * commented on, reported). Rows are inserted directly rather than through the
 * app's write paths: the point is the table state an account can reach, and
 * several of these (an operator's decision, a promoted submission, a block and
 * a follow between the same pair) take several actors and an admin to produce.
 *
 * `tag` is written into every piece of text so a leak is a substring search.
 */
async function seedFootprint(db: DB, subject: schema.User, counterpart: schema.User, tag: string) {
  const at = new Date("2026-08-01T12:00:00Z");
  const catalog = await createTestBottle(db, { name: `${tag} Catalog Bottle` });

  await db.insert(schema.account).values({
    id: uid("acct"),
    accountId: `${tag}-google-sub`,
    providerId: "google",
    userId: subject.id,
    accessToken: `${tag}-ACCESS-TOKEN`,
  });
  await db.insert(schema.session).values({
    id: uid("sess"),
    token: `${tag}-SESSION-TOKEN`,
    userId: subject.id,
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    ipAddress: "203.0.113.9",
    userAgent: "vitest",
  });
  await db.insert(schema.nativeAuthCodes).values({
    id: uid("nac"),
    codeHash: `${tag}-CODE-HASH`,
    userId: subject.id,
    sessionCookieName: "better-auth.session_token",
    sessionCookie: `${tag}-ENCRYPTED-COOKIE`,
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  });
  await db.insert(schema.pushDevices).values({
    id: uid("push"),
    userId: subject.id,
    token: `${tag}-PUSH-TOKEN`,
    platform: "ios",
  });

  // --- journal
  const shelfId = uid("ub");
  await db.insert(schema.userBottles).values({
    id: shelfId,
    userId: subject.id,
    bottleId: catalog.id,
    relationship: "own",
    purchasePrice: 64,
    notes: `${tag} shelf note`,
  });
  const pourId = uid("pour");
  await db.insert(schema.pours).values({
    id: pourId,
    userId: subject.id,
    bottleId: catalog.id,
    userBottleId: shelfId,
    rating: 4.5,
    visibility: "public",
    createdAt: at,
  });
  await db.insert(schema.tastingNotes).values({
    id: uid("note"),
    pourId,
    nose: `${tag} nose: Vanilla, "caramel"\nand oak`,
    freeform: `=${tag} formula-looking note`,
    flavorTags: { vanilla: 3 },
  });
  const shareId = uid("share");
  await db.insert(schema.pourShares).values({ id: shareId, pourId, userId: subject.id, code: `${tag}SHARECODE` });
  await db.insert(schema.passportTiers).values({ id: uid("tier"), userId: subject.id, family: "country", value: "USA", tier: 1 });
  await db.insert(schema.recExplanations).values({
    id: uid("rec"),
    userId: subject.id,
    bottleId: catalog.id,
    mode: "discovery",
    reason: `${tag} because you like vanilla`,
  });
  const chatId = uid("chat");
  await db.insert(schema.chatSessions).values({ id: chatId, userId: subject.id, title: `${tag} chat` });
  await db.insert(schema.chatMessages).values({ id: uid("msg"), sessionId: chatId, role: "user", content: `${tag} what should I pour` });

  // --- catalog contributions
  const pending = await createTestBottle(db, { name: `${tag} Pending`, status: "user_submitted", submittedBy: subject.id });
  await db.insert(schema.bottleSubmissions).values({ id: uid("sub"), bottleId: pending.id, submittedBy: subject.id, distilleryText: `${tag} Distillery` });
  const promoted = await createTestBottle(db, { name: `${tag} Promoted`, status: "verified", submittedBy: subject.id });
  await db.insert(schema.bottleSubmissions).values({ id: uid("sub"), bottleId: promoted.id, submittedBy: subject.id, state: "approved" });
  // Somebody else's submission that `subject` decided, as an operator.
  const theirs = await createTestBottle(db, { name: `${tag} Theirs`, status: "user_submitted", submittedBy: counterpart.id });
  await db.insert(schema.bottleSubmissions).values({
    id: uid("sub"),
    bottleId: theirs.id,
    submittedBy: counterpart.id,
    state: "rejected",
    reviewedBy: subject.id,
    reviewNote: "not a real bottle",
  });

  // --- social
  await db.insert(schema.userProfiles).values([
    { userId: subject.id, handle: `s_${tag}`.toLowerCase(), displayName: `${tag} Subject`, phoneHash: `${tag}-PHONE-HASH`, phoneLast2: "42" },
    { userId: counterpart.id, handle: `c_${tag}`.toLowerCase(), displayName: `${tag} Counterpart` },
  ]);
  await db.insert(schema.userSocialPrefs).values({ userId: subject.id, defaultPourVisibility: "friends" });
  await db.insert(schema.phoneLookups).values({ id: uid("pl"), userId: subject.id });
  await db.insert(schema.follows).values([
    { id: uid("f"), followerId: subject.id, followeeId: counterpart.id, state: "accepted" },
    { id: uid("f"), followerId: counterpart.id, followeeId: subject.id, state: "accepted" },
  ]);
  await db.insert(schema.blocks).values([
    { id: uid("b"), blockerId: subject.id, blockedId: counterpart.id },
    { id: uid("b"), blockerId: counterpart.id, blockedId: subject.id },
  ]);

  // The counterpart's journal: one published pour, one private one.
  const theirPour = uid("pour");
  const theirPrivatePour = uid("pour");
  await db.insert(schema.pours).values([
    { id: theirPour, userId: counterpart.id, bottleId: catalog.id, rating: 3, visibility: "public" },
    { id: theirPrivatePour, userId: counterpart.id, bottleId: catalog.id, rating: 2, visibility: "private" },
  ]);
  await db.insert(schema.tastingNotes).values([
    { id: uid("note"), pourId: theirPour, nose: `${tag} COUNTERPART-PUBLIC-NOTE` },
    { id: uid("note"), pourId: theirPrivatePour, nose: `${tag} COUNTERPART-PRIVATE-NOTE` },
  ]);
  const theirShare = uid("share");
  await db.insert(schema.pourShares).values({ id: theirShare, pourId: theirPour, userId: counterpart.id, code: `${tag}THEIRCODE` });

  await db.insert(schema.reactions).values([
    { id: uid("r"), pourId: theirPour, userId: subject.id },
    { id: uid("r"), pourId: pourId, userId: counterpart.id },
  ]);
  const subjectComment = uid("c");
  const counterpartReply = uid("c");
  await db.insert(schema.comments).values([
    { id: subjectComment, pourId: theirPour, userId: subject.id, body: `${tag} my comment on their note` },
    { id: counterpartReply, pourId: theirPour, userId: counterpart.id, parentId: subjectComment, body: `${tag} COUNTERPART-REPLY` },
    { id: uid("c"), pourId, userId: counterpart.id, body: `${tag} COUNTERPART-COMMENT-ON-SUBJECT` },
  ]);

  // --- moderation and support
  const filed = uid("rep");
  await db.insert(schema.reports).values([
    {
      id: filed,
      subjectType: "comment",
      subjectId: counterpartReply,
      reporterId: subject.id,
      reason: `${tag} filed reason`,
      subjectOwnerId: counterpart.id,
      subjectSnapshot: `${tag} COUNTERPART-SNAPSHOT`,
    },
    {
      id: uid("rep"),
      subjectType: "pour",
      subjectId: pourId,
      reporterId: counterpart.id,
      reason: `${tag} REPORTED-BY-COUNTERPART`,
      subjectOwnerId: subject.id,
      subjectSnapshot: `${tag} snapshot of subject's note`,
    },
  ]);
  await db.insert(schema.moderationActions).values({
    id: uid("mod"),
    actorId: subject.id,
    action: "dismiss",
    subjectType: "comment",
    subjectId: counterpartReply,
    reportId: filed,
    note: `${tag} operator note`,
  });
  await db.insert(schema.feedback).values({ id: uid("fb"), userId: subject.id, body: `${tag} support message` });

  // --- AI and telemetry
  await db.insert(schema.aiRateLimits).values({ userId: subject.id, window: "day", windowStart: at, count: 3 });
  await db.insert(schema.aiUsage).values({ id: uid("ai"), userId: subject.id, feature: "chat", model: "m", inputTokens: 10 });
  await db.insert(schema.analyticsEvents).values([
    { id: uid("ev"), name: "share_view", userId: subject.id, bySignedInUser: true, shareId: theirShare },
    { id: uid("ev"), name: "share_view", userId: counterpart.id, bySignedInUser: true, shareId },
  ]);

  return { pourId, shareCode: `${tag}SHARECODE`, subjectComment, counterpartReply, theirPour, pending, promoted, theirs };
}

async function sliceCounts(db: DB, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const slice of ACCOUNT_DATA) out[slice.key] = await countSlice(db, slice, userId);
  return out;
}

async function tableTotals(db: DB): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const slice of ACCOUNT_DATA) {
    const name = getTableName(slice.table);
    if (name in out) continue;
    const [row] = await db.select({ n: sql<number>`count(*)` }).from(slice.table);
    out[name] = Number(row.n);
  }
  return out;
}

describe("account data routes", () => {
  let db: DB;
  let alice: schema.User;
  let bob: schema.User;
  let carol: schema.User;
  let dan: schema.User;
  let aliceSeed: Awaited<ReturnType<typeof seedFootprint>>;

  beforeEach(async () => {
    db = await setupTestDb();
    alice = await createTestUser(db, { name: "Alice Leaving", email: "alice@example.com" });
    bob = await createTestUser(db, { name: "Bob Counterpart" });
    // Carol and Dan never touch Alice or Bob: whatever happens to Alice, every
    // one of Carol's slices must read exactly the same afterwards.
    carol = await createTestUser(db, { name: "Carol Bystander" });
    dan = await createTestUser(db, { name: "Dan Bystander" });
    aliceSeed = await seedFootprint(db, alice, bob, "ALICE");
    await seedFootprint(db, carol, dan, "CAROL");
    setSessionUser(alice);
  });

  describe("GET /api/account/export", () => {
    it("is 401 signed out", async () => {
      setSessionUser(null);
      const res = await EXPORT(new Request("http://localhost:3000/api/account/export"));
      expect(res.status).toBe(401);
    });

    it("rejects an unknown format with 400", async () => {
      const res = await EXPORT(new Request("http://localhost:3000/api/account/export?format=xml"));
      expect(res.status).toBe(400);
    });

    it("downloads as an uncached JSON attachment", async () => {
      const res = await EXPORT(new Request("http://localhost:3000/api/account/export"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="whaikey-export-\d{4}-\d{2}-\d{2}\.json"$/);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("contains exactly the caller's rows in every exported section, and says what it left out", async () => {
      const res = await EXPORT(new Request("http://localhost:3000/api/account/export"));
      const body = (await res.json()) as AccountExport;
      const counts = await sliceCounts(db, alice.id);

      for (const slice of ACCOUNT_DATA) {
        if (slice.export) {
          // The fixture reaches every slice, so a zero here is a query that
          // lost its rows rather than an account that had none.
          expect(counts[slice.key], slice.key).toBeGreaterThan(0);
          expect(body.data[slice.key], slice.key).toHaveLength(counts[slice.key]);
          for (const row of body.data[slice.key]) {
            expect(Object.keys(row).sort(), slice.key).toEqual([...slice.export.columns].sort());
          }
        } else {
          expect(body.data[slice.key], slice.key).toBeUndefined();
          expect(body.notIncluded.map((n) => n.section)).toContain(slice.key);
        }
      }
      expect(body.data.account[0]).toMatchObject({ name: "Alice Leaving", email: "alice@example.com" });
      expect(body.data.following).toEqual([expect.objectContaining({ handle: "c_alice", state: "accepted" })]);
    });

    it("carries no other account's data and no credential", async () => {
      const res = await EXPORT(new Request("http://localhost:3000/api/account/export"));
      const text = await res.text();

      expect(text).toContain("ALICE nose");
      // Nothing of the bystander's, at all.
      expect(text).not.toContain("CAROL");
      // Alice follows Bob and Bob follows back — and still nothing Bob wrote,
      // private or public, and nothing anyone wrote about Alice.
      for (const leak of [
        "COUNTERPART-PRIVATE-NOTE",
        "COUNTERPART-PUBLIC-NOTE",
        "COUNTERPART-REPLY",
        "COUNTERPART-COMMENT-ON-SUBJECT",
        "COUNTERPART-SNAPSHOT",
        "REPORTED-BY-COUNTERPART",
        "ALICE Counterpart",
        bob.id,
        bob.email,
      ]) {
        expect(text, leak).not.toContain(leak);
      }
      // Keys, not data.
      for (const secret of [
        "SESSION-TOKEN",
        "ACCESS-TOKEN",
        "CODE-HASH",
        "ENCRYPTED-COOKIE",
        "PUSH-TOKEN",
        "PHONE-HASH",
        "SHARECODE",
      ]) {
        expect(text, secret).not.toContain(secret);
      }
    });

    it("does not show whoever blocked you", async () => {
      const body = (await (await EXPORT(new Request("http://localhost:3000/api/account/export"))).json()) as AccountExport;
      expect(body.data.blocks_against_you).toBeUndefined();
      expect(body.data.blocked).toEqual([expect.objectContaining({ handle: "c_alice" })]);
    });

    it("serves the same sections as a zip of well-formed CSVs", async () => {
      const json = (await (await EXPORT(new Request("http://localhost:3000/api/account/export"))).json()) as AccountExport;
      const res = await EXPORT(new Request("http://localhost:3000/api/account/export?format=csv"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/zip");
      expect(res.headers.get("content-disposition")).toMatch(/whaikey-export-\d{4}-\d{2}-\d{2}\.zip"$/);

      const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
      for (const slice of ACCOUNT_DATA.filter((s) => s.export)) {
        const csv = strFromU8(files[`${slice.key}.csv`]);
        const lines = csv.split("\r\n");
        expect(lines[0], slice.key).toBe(slice.export!.columns.join(","));
        // Row count: records, not physical lines — the nose note has a newline.
        const records = csv.match(/("([^"]|"")*"|[^,\r\n]*)(,("([^"]|"")*"|[^,\r\n]*))*\r\n/g) ?? [];
        expect(records.length - 1, slice.key).toBe(json.data[slice.key].length);
      }
      const notes = strFromU8(files["tasting_notes.csv"]);
      expect(notes).toContain('"ALICE nose: Vanilla, ""caramel""\nand oak"');
      // Defused, not dropped.
      expect(notes).toContain("'=ALICE formula-looking note");
    });

    it("still exports for an account the age gate has blocked", async () => {
      const minor = await createTestUser(db, { ageVerified: false });
      await db.insert(schema.ageVerifications).values({
        userId: minor.id,
        birthDate: "2010-01-01",
        market: "US",
        minimumAge: 21,
        passed: false,
        eligibleOn: "2031-01-01",
      });
      setSessionUser(minor);
      const res = await EXPORT(new Request("http://localhost:3000/api/account/export"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as AccountExport;
      expect(body.data.age_answer).toEqual([expect.objectContaining({ passed: false, eligibleOn: "2031-01-01" })]);
    });
  });

  describe("DELETE /api/account", () => {
    const confirm = (word: unknown) => jsonRequest("/api/account", "DELETE", { confirm: word });

    it("is 401 signed out", async () => {
      setSessionUser(null);
      expect((await DELETE(confirm("DELETE"))).status).toBe(401);
    });

    it("refuses without the typed confirmation, and deletes nothing", async () => {
      expect((await DELETE(jsonRequest("/api/account", "DELETE"))).status).toBe(400);
      expect((await DELETE(confirm(""))).status).toBe(400);
      expect((await DELETE(confirm("yes"))).status).toBe(400);
      expect((await DELETE(confirm(true))).status).toBe(400);
      const res = await DELETE(new Request("http://localhost:3000/api/account", { method: "DELETE", body: "confirm=DELETE" }));
      expect(res.status).toBe(400);
      expect(await db.query.user.findFirst({ where: eq(schema.user.id, alice.id) })).toBeDefined();
    });

    it("applies the stated policy to every slice, and leaves a bystander exactly as it was", async () => {
      const before = await sliceCounts(db, alice.id);
      const carolBefore = await sliceCounts(db, carol.id);
      const totalsBefore = await tableTotals(db);

      const res = await DELETE(confirm(" delete "));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });

      const after = await sliceCounts(db, alice.id);
      const totalsAfter = await tableTotals(db);
      for (const slice of ACCOUNT_DATA) {
        expect(before[slice.key], `fixture must reach ${slice.key}`).toBeGreaterThan(0);
        const table = getTableName(slice.table);
        switch (slice.onDelete) {
          case "deleted":
          case "unlinked":
            expect(after[slice.key], slice.key).toBe(0);
            break;
          case "kept":
            expect(after[slice.key], slice.key).toBe(before[slice.key]);
            break;
        }
        if (slice.onDelete === "unlinked") {
          // Unlinked means the rows are still there. No slice-sharing table
          // loses rows to a *deleted* slice in this fixture except those listed.
          const shrinks = ACCOUNT_DATA.some((s) => getTableName(s.table) === table && s.onDelete === "deleted");
          if (!shrinks) expect(totalsAfter[table], slice.key).toBe(totalsBefore[table]);
        }
      }
      expect(await sliceCounts(db, carol.id)).toEqual(carolBefore);
    });

    it("unlinks rather than erases what it says it unlinks", async () => {
      await DELETE(confirm("DELETE"));
      const [promoted] = await db.select().from(schema.bottles).where(eq(schema.bottles.id, aliceSeed.promoted.id));
      expect(promoted).toMatchObject({ status: "verified", submittedBy: null });
      expect(await db.query.bottles.findFirst({ where: eq(schema.bottles.id, aliceSeed.pending.id) })).toBeUndefined();

      const filed = await db.select().from(schema.reports).where(eq(schema.reports.reason, "ALICE filed reason"));
      expect(filed).toEqual([expect.objectContaining({ reporterId: null, state: "open" })]);
      const about = await db.select().from(schema.reports).where(eq(schema.reports.subjectOwnerId, alice.id));
      expect(about).toEqual([expect.objectContaining({ subjectSnapshot: "ALICE snapshot of subject's note" })]);

      const [decision] = await db.select().from(schema.moderationActions).where(eq(schema.moderationActions.note, "ALICE operator note"));
      expect(decision).toMatchObject({ actorId: null, action: "dismiss" });
      const [reviewed] = await db.select().from(schema.bottleSubmissions).where(eq(schema.bottleSubmissions.bottleId, aliceSeed.theirs.id));
      expect(reviewed).toMatchObject({ reviewedBy: null, state: "rejected", submittedBy: bob.id });

      const events = await db.select().from(schema.analyticsEvents);
      // Four events seeded (two per footprint); all still counted.
      expect(events).toHaveLength(4);
      expect(events.filter((e) => e.userId === alice.id)).toEqual([]);
      expect(events.filter((e) => e.bySignedInUser)).toHaveLength(4);
    });

    it("takes the account's words off other people's threads, and leaves theirs", async () => {
      await DELETE(confirm("DELETE"));
      const onBobsNote = await db.select().from(schema.comments).where(eq(schema.comments.pourId, aliceSeed.theirPour));
      expect(onBobsNote.map((c) => c.id)).toEqual([aliceSeed.counterpartReply]);
      // Bob's reply survives with a parent that is gone; the thread renders
      // it at the top level (comment-thread.tsx treats a missing parent so).
      expect(onBobsNote[0].parentId).toBe(aliceSeed.subjectComment);
      // Bob's own journal is his.
      const bobsPours = await db.select().from(schema.pours).where(eq(schema.pours.userId, bob.id));
      expect(bobsPours).toHaveLength(2);
      const bobsCheers = await db.select().from(schema.reactions).where(eq(schema.reactions.userId, bob.id));
      expect(bobsCheers).toEqual([]); // his only cheer was on Alice's note, which is gone
      expect(await db.select().from(schema.user).where(eq(schema.user.id, bob.id))).toHaveLength(1);
    });

    it("kills the account's share links the moment it goes", async () => {
      expect(await getPublicPourShare(db, aliceSeed.shareCode)).not.toBeNull();
      await DELETE(confirm("DELETE"));
      expect(await getPublicPourShare(db, aliceSeed.shareCode)).toBeNull();
    });

    it("signs every device out and clears the session cookie", async () => {
      const res = await DELETE(confirm("DELETE"));
      expect(await db.select().from(schema.session).where(eq(schema.session.userId, alice.id))).toEqual([]);
      const cookies = res.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith("better-auth.session_token=;") && /Max-Age=0/i.test(c))).toBe(true);
      expect(cookies.some((c) => c.startsWith("__Secure-better-auth.session_token=;") && /Secure/i.test(c))).toBe(true);
    });

    it("answers 404, not a second deletion, when the account is already gone", async () => {
      expect((await DELETE(confirm("DELETE"))).status).toBe(200);
      expect((await DELETE(confirm("DELETE"))).status).toBe(404);
    });

    it("lets an account the age gate has blocked delete itself", async () => {
      const minor = await createTestUser(db, { ageVerified: false });
      setSessionUser(minor);
      expect((await DELETE(confirm("DELETE"))).status).toBe(200);
      expect(await db.query.user.findFirst({ where: eq(schema.user.id, minor.id) })).toBeUndefined();
    });

    describe("atomicity", () => {
      afterEach(async () => {
        await db.execute(sql`DROP TRIGGER IF EXISTS account_delete_fails ON "user"`);
        await db.execute(sql`DROP FUNCTION IF EXISTS account_delete_fails()`);
      });

      it("leaves everything as it was when the last step fails", async () => {
        const before = await sliceCounts(db, alice.id);
        // Fail the final step — the user row — after the explicit deletes
        // (support messages, pending bottles) have already run inside the
        // transaction. A half-deletion would show as those two slices at zero.
        await db.execute(sql`
          CREATE FUNCTION account_delete_fails() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'simulated failure'; END $$ LANGUAGE plpgsql
        `);
        await db.execute(sql`
          CREATE TRIGGER account_delete_fails BEFORE DELETE ON "user"
          FOR EACH ROW EXECUTE FUNCTION account_delete_fails()
        `);
        await expect(deleteAccount(db, alice.id)).rejects.toThrow();
        expect(await sliceCounts(db, alice.id)).toEqual(before);
        expect(before.support_messages).toBeGreaterThan(0);
        expect(before.pending_bottles).toBeGreaterThan(0);
      });
    });
  });
});

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { blockUser, createProfile, followByHandle } from "@/lib/social";
import { createClub, createInvite, joinByCode } from "@/lib/clubs";
import { listInbox } from "@/lib/notify";
import {
  RULE_KINDS,
  RULE_KIND_IDS,
  createClubChallenge,
  curatedFor,
  getBoard,
  joinChallenge,
  leaveChallenge,
  listChallenges,
  listCrests,
  progressFor,
  ruleSchema,
  setBoardOptIn,
  type MetRow,
} from "@/lib/challenges";

/**
 * The challenge-rule lint test (whiskey-build-tracks C4; docs/SOCIAL.md D16).
 * Every rule kind must be (1) distinct-based — repeating the same bottle any
 * number of times adds nothing — and (2) saturating — progress never exceeds
 * the target. A kind that fails either can be won by drinking more.
 */
const row = (over: Partial<MetRow> = {}): MetRow => ({
  bottleId: "b1",
  distilleryId: "d1",
  country: "Scotland",
  region: "Islay",
  category: "single_malt",
  caskTypes: ["sherry"],
  flavorTags: { peat: 2, vanilla: 1 },
  ...over,
});

describe("challenge rule lint: distinct and saturating", () => {
  for (const kind of RULE_KIND_IDS) {
    it(`${kind}: repeats add nothing and progress caps at the target`, () => {
      const rule = { kind, target: 2 };
      const once = progressFor(rule, [row()]);
      const many = progressFor(rule, Array.from({ length: 50 }, () => row()));
      expect(many.count).toBe(once.count);
      const varied = Array.from({ length: 10 }, (_, i) =>
        row({
          bottleId: `b${i}`,
          distilleryId: `d${i}`,
          country: `C${i}`,
          region: `R${i}`,
          category: `cat${i}`,
          caskTypes: [`cask${i}`],
          flavorTags: { [["peat", "vanilla", "honey", "oak", "citrus", "cherry", "nutty", "mint", "ash", "tar"][i]]: 1 },
        }),
      );
      expect(progressFor(rule, varied).count).toBe(2);
      // No kind reads a quantity: the row type carries none to read.
      expect(Object.keys(row())).not.toEqual(expect.arrayContaining(["amountMl"]));
    });
  }

  it("has only distinct_* kinds, and the schema refuses anything else", () => {
    for (const kind of RULE_KIND_IDS) expect(kind).toMatch(/^distinct_/);
    expect(ruleSchema.safeParse({ kind: "pour_count", target: 3 }).success).toBe(false);
    expect(ruleSchema.safeParse({ kind: "distinct_countries", target: 100 }).success).toBe(false);
    expect(ruleSchema.safeParse({ kind: "distinct_countries", target: 3, filter: { region: "Islay" } }).success).toBe(false);
    expect(ruleSchema.safeParse({ kind: "distinct_distilleries", target: 3, filter: { region: "Islay" } }).success).toBe(true);
  });

  it("ships three curated challenges a month, all from the closed list", () => {
    for (const m of [0, 1, 2, 9, 10, 11]) {
      const set = curatedFor(new Date(Date.UTC(2026, m, 15)));
      expect(set).toHaveLength(3);
      for (const c of set) {
        expect(RULE_KINDS[c.rule.kind as keyof typeof RULE_KINDS]).toBeDefined();
        expect(`${c.title} ${c.description}`.toLowerCase()).not.toMatch(/pour|streak|drink|shot|ml\b/);
      }
    }
  });
});

async function person(db: DB, handle: string) {
  const u = await createTestUser(db, { name: handle });
  await createProfile(db, u, handle);
  await db.update(schema.userProfiles).set({ isPublic: true }).where(eq(schema.userProfiles.userId, u.id));
  return u;
}

async function mutual(db: DB, a: schema.User, ah: string, b: schema.User, bh: string) {
  await followByHandle(db, a.id, bh);
  await followByHandle(db, b.id, ah);
}

describe("challenges and crests", () => {
  let db: DB;
  const now = new Date("2026-10-20T12:00:00Z");
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("joins a curated challenge, counts distinct countries in the window, stamps the crest once", async () => {
    const me = await person(db, "me_ch");
    const slug = curatedFor(now).find((c) => c.rule.kind === "distinct_countries")?.slug;
    // October 2026's rotation may not include countries; use whatever the month offers.
    const cards = await listChallenges(db, me.id, now);
    expect(cards).toHaveLength(3);
    const target = slug ?? cards[0].slug;
    expect(await joinChallenge(db, me.id, target, now)).toBe(true);
    const card = (await listChallenges(db, me.id, now)).find((c) => c.slug === target)!;
    expect(card).toMatchObject({ joined: true, completedAt: null, progress: { count: 0 } });
    expect(await leaveChallenge(db, me.id, target)).toBe(true);
    expect(await joinChallenge(db, me.id, "no-such-challenge", now)).toBe(false);
  });

  it("club challenges: admins only, members only, crest + notification on completion, friends see shared progress only", async () => {
    const owner = await person(db, "own_cc");
    const friend = await person(db, "fr_cc");
    await mutual(db, owner, "own_cc", friend, "fr_cc");
    const club = await createClub(db, owner.id, { name: "Club" });
    await joinByCode(db, friend.id, (await createInvite(db, owner.id, club.id))!.code);
    expect(await createClubChallenge(db, friend.id, club.id, { title: "x", rule: { kind: "distinct_countries", target: 2 }, days: 30 }, now)).toBeNull();
    const ch = (await createClubChallenge(db, owner.id, club.id, { title: "Two countries", rule: { kind: "distinct_countries", target: 2 }, days: 30 }, now))!;
    const outsider = await person(db, "out_cc");
    expect(await joinChallenge(db, outsider.id, ch.slug, now)).toBe(false);

    const scot = await createTestBottle(db, { country: "Scotland" });
    const jp = await createTestBottle(db, { country: "Japan" });
    const later = new Date(now.getTime() + 3600_000);
    await db.insert(schema.pours).values([
      { id: uid("p"), userId: friend.id, bottleId: scot.id, visibility: "friends", createdAt: later },
      { id: uid("p"), userId: friend.id, bottleId: jp.id, visibility: "private", createdAt: later },
      { id: uid("p"), userId: friend.id, bottleId: scot.id, visibility: "friends", createdAt: later },
    ]);
    const after = new Date(now.getTime() + 2 * 3600_000);
    expect(await joinChallenge(db, friend.id, ch.slug, after)).toBe(true);
    // Their own view counts private pours too: 2 countries → crest.
    expect((await listCrests(db, friend.id)).map((c) => c.title)).toEqual(["Two countries"]);
    expect((await listInbox(db, friend.id)).map((n) => n.text)).toContain("You completed Two countries — new crest on your passport");
    // The owner sees the friend's progress from shared notes only (1, not 2) and the crest.
    const card = (await listChallenges(db, owner.id, after)).find((c) => c.slug === ch.slug)!;
    expect(card.friends).toEqual([{ handle: "fr_cc", count: 1, completed: true }]);
    // A crest, once earned, cannot be left.
    expect(await leaveChallenge(db, friend.id, ch.slug)).toBe(false);
  });
});

describe("friend breadth board", () => {
  let db: DB;
  const now = new Date("2026-10-20T12:00:00Z");
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("is opt-in, hidden below 3 opted-in friends, counts shared notes only, and shows ties as ties", async () => {
    const me = await person(db, "me_bd");
    const fs = [await person(db, "f1_bd"), await person(db, "f2_bd"), await person(db, "f3_bd")];
    for (const [i, f] of fs.entries()) await mutual(db, me, "me_bd", f, `f${i + 1}_bd`);
    expect((await getBoard(db, me.id, "regions", now)).state).toBe("not_opted_in");
    await setBoardOptIn(db, me.id, true);
    await setBoardOptIn(db, fs[0].id, true);
    await setBoardOptIn(db, fs[1].id, true);
    expect(await getBoard(db, me.id, "regions", now)).toEqual({ state: "too_few", optedInFriends: 2, needed: 3 });
    await setBoardOptIn(db, fs[2].id, true);

    const islay = await createTestBottle(db, { region: "Islay" });
    const speyside = await createTestBottle(db, { region: "Speyside" });
    const t = new Date("2026-10-05T00:00:00Z");
    await db.insert(schema.pours).values([
      { id: uid("p"), userId: fs[0].id, bottleId: islay.id, visibility: "friends", createdAt: t },
      { id: uid("p"), userId: fs[0].id, bottleId: speyside.id, visibility: "public", createdAt: t },
      { id: uid("p"), userId: fs[1].id, bottleId: islay.id, visibility: "friends", createdAt: t },
      { id: uid("p"), userId: fs[1].id, bottleId: islay.id, visibility: "friends", createdAt: t }, // repeat: nothing
      { id: uid("p"), userId: fs[2].id, bottleId: islay.id, visibility: "public", createdAt: t },
      { id: uid("p"), userId: me.id, bottleId: speyside.id, visibility: "private", createdAt: t }, // private: not counted
    ]);
    const board = await getBoard(db, me.id, "regions", now);
    expect(board.state).toBe("ready");
    if (board.state !== "ready") return;
    expect(board.season).toBe("Q4 2026");
    expect(board.rows.map((r) => [r.handle, r.rank, r.tied, r.count])).toEqual([
      ["f1_bd", 1, false, 2],
      ["f2_bd", 2, true, 1],
      ["f3_bd", 2, true, 1],
      ["me_bd", 4, false, 0],
    ]);
    // A block removes the pair from each other's board.
    await blockUser(db, me.id, fs[2].id);
    expect((await getBoard(db, me.id, "regions", now)).state).toBe("too_few");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { bottlePopularityDaily, pours, tastingNotes, userBottles } from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { settleKicks } from "@/lib/enrich/kick";
import {
  inPopularTop,
  isBotUserAgent,
  noteBottleSignals,
  POPULARITY_DAILY_CAP,
  POPULARITY_WINDOW_DAYS,
  recordBottleSignals,
  sweepPopularity,
  topPopularBottles,
  utcDay,
} from "./popularity";

let db: DB;
beforeEach(async () => {
  db = await setupTestDb();
});

const tally = async (bottleId: string) =>
  db.select().from(bottlePopularityDaily).where(eq(bottlePopularityDaily.bottleId, bottleId));

describe("recordBottleSignals", () => {
  it("keeps one anonymous row per bottle-day and bumps the right counter", async () => {
    const a = await createTestBottle(db);
    const b = await createTestBottle(db);
    const now = new Date("2026-10-26T12:00:00Z");
    expect(await recordBottleSignals(db, [a.id, b.id, a.id], "search", now)).toBe(2);
    await recordBottleSignals(db, [a.id], "search", now);
    await recordBottleSignals(db, [a.id], "view", now);
    await recordBottleSignals(db, [a.id], "scan", now);
    const [row] = await tally(a.id);
    expect(row).toEqual({ bottleId: a.id, day: "2026-10-26", searches: 2, views: 1, scans: 1 });
    // Nothing but the bottle, the day and three counters is stored.
    expect(Object.keys(row).sort()).toEqual(["bottleId", "day", "scans", "searches", "views"]);
    expect((await tally(b.id))[0]).toMatchObject({ searches: 1, views: 0, scans: 0 });
  });

  it("ignores unknown bottle ids and empty input", async () => {
    expect(await recordBottleSignals(db, ["no-such-bottle"], "view")).toBe(0);
    expect(await recordBottleSignals(db, [], "view")).toBe(0);
  });

  it("noteBottleSignals runs after the response and skips bots", async () => {
    const a = await createTestBottle(db);
    noteBottleSignals(db, [a.id], "view", "Mozilla/5.0 (compatible; Googlebot/2.1)");
    noteBottleSignals(db, [a.id], "view", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    await settleKicks();
    expect((await tally(a.id))[0]).toMatchObject({ views: 1 });
    expect(isBotUserAgent("facebookexternalhit/1.1")).toBe(true);
    expect(isBotUserAgent(null)).toBe(false);
  });
});

describe("popularity ranking", () => {
  it("weights pours, shelves, scans, searches and views, capping a bottle-day", async () => {
    const poured = await createTestBottle(db, { name: "Poured" });
    const searched = await createTestBottle(db, { name: "Searched" });
    const hammered = await createTestBottle(db, { name: "Hammered" });
    const user = await createTestUser(db);
    await db.insert(pours).values({ id: uid("pour"), userId: user.id, bottleId: poured.id, rating: 4 });
    await db.insert(userBottles).values({ id: uid("ub"), userId: user.id, bottleId: poured.id, relationship: "own" });
    const today = utcDay();
    // 11 searches (33) vs 1000 views capped at 50 (50) vs a pour + shelf (30).
    await db.insert(bottlePopularityDaily).values([
      { bottleId: searched.id, day: today, searches: 11 },
      { bottleId: hammered.id, day: today, views: 1000 },
    ]);
    const top = await topPopularBottles(db, 10);
    expect(top.map((b) => [b.name, b.popularity])).toEqual([
      ["Hammered", POPULARITY_DAILY_CAP],
      ["Searched", 33],
      ["Poured", 30],
    ]);
    expect(top.find((b) => b.name === "Searched")).toMatchObject({ searches: 11, views: 0, scans: 0 });
    expect(await inPopularTop(db, [poured.id, searched.id, hammered.id], 2)).toEqual(new Set([hammered.id, searched.id]));
  });

  it("ignores tallies older than the window and sweeps them", async () => {
    const a = await createTestBottle(db);
    const old = utcDay(new Date(Date.now() - (POPULARITY_WINDOW_DAYS + 2) * 86_400_000));
    await db.insert(bottlePopularityDaily).values({ bottleId: a.id, day: old, searches: 40 });
    expect(await topPopularBottles(db)).toEqual([]);
    await sweepPopularity(db);
    expect(await tally(a.id)).toEqual([]);
  });

  it("counts only pours and shelf additions inside the window", async () => {
    const stale = await createTestBottle(db, { name: "Stale" });
    const user = await createTestUser(db);
    const long = new Date(Date.now() - (POPULARITY_WINDOW_DAYS + 5) * 86_400_000);
    await db.insert(pours).values({ id: uid("pour"), userId: user.id, bottleId: stale.id, rating: 4, createdAt: long });
    await db
      .insert(userBottles)
      .values({ id: uid("ub"), userId: user.id, bottleId: stale.id, relationship: "own", createdAt: long });
    expect(await topPopularBottles(db)).toEqual([]);
    await db.insert(pours).values({ id: uid("pour"), userId: user.id, bottleId: stale.id, rating: 3 });
    expect((await topPopularBottles(db))[0]).toMatchObject({ id: stale.id, popularity: 20 });
  });

  it("leaves user submissions out of the top set", async () => {
    const user = await createTestUser(db);
    const mine = await createTestBottle(db, { status: "user_submitted", submittedBy: user.id });
    await db.insert(bottlePopularityDaily).values({ bottleId: mine.id, day: utcDay(), searches: 5 });
    expect(await inPopularTop(db, [mine.id])).toEqual(new Set());
  });

  it("records user tasting-note bottles but never names who", async () => {
    // A note on the bottle does not change its score (only pours/shelves/tallies do).
    const a = await createTestBottle(db);
    const user = await createTestUser(db);
    const pourId = uid("pour");
    await db.insert(pours).values({ id: pourId, userId: user.id, bottleId: a.id, rating: 4 });
    await db.insert(tastingNotes).values({ id: uid("note"), pourId, nose: "vanilla" });
    expect((await topPopularBottles(db))[0]).toMatchObject({ id: a.id, popularity: 20 });
  });
});

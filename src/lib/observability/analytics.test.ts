import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  isAutomatedFetch,
  recordEvent,
  recordEvents,
  recordShareConversion,
  shareIdForCode,
} from "./analytics";
import { setErrorReporterForTests, type CapturedEvent } from "./errors";

/**
 * The contract this module states about itself: recording must not be able to
 * break the thing it is measuring. These are the tests for that sentence,
 * which did not exist while the sentence did.
 */

let db: DB;
beforeEach(async () => {
  db = await setupTestDb();
});

async function shareOf(ownerId: string, bottleId: string): Promise<string> {
  const pourId = uid("pour");
  await db.insert(schema.pours).values({ id: pourId, userId: ownerId, bottleId, visibility: "public" });
  const id = uid("share");
  await db.insert(schema.pourShares).values({ id, pourId, userId: ownerId, code: uid("code") });
  return id;
}

describe("recording a share conversion", () => {
  it("records the conversion when the share really is for that bottle", async () => {
    const owner = await createTestUser(db);
    const viewer = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const shareId = await shareOf(owner.id, bottle.id);

    await recordShareConversion(db, {
      shareId,
      bottleId: bottle.id,
      userId: viewer.id,
      relationship: "wishlist",
    });

    const events = await db.select().from(schema.analyticsEvents);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("share_wishlist_add");
  });

  it("refuses a share that is not about that bottle, and the sharer's own add", async () => {
    const owner = await createTestUser(db);
    const viewer = await createTestUser(db);
    const shared = await createTestBottle(db, { name: "Shared" });
    const other = await createTestBottle(db, { name: "Unrelated" });
    const shareId = await shareOf(owner.id, shared.id);

    // The id exists, so the foreign key is satisfied — which proves nothing.
    await recordShareConversion(db, {
      shareId,
      bottleId: other.id,
      userId: viewer.id,
      relationship: "wishlist",
    });
    // And the funnel is about recipients, not the person who made the link.
    await recordShareConversion(db, {
      shareId,
      bottleId: shared.id,
      userId: owner.id,
      relationship: "wishlist",
    });

    expect(await db.select().from(schema.analyticsEvents)).toHaveLength(0);
  });

  it("never lets a telemetry failure change the answer about the shelf", async () => {
    const owner = await createTestUser(db);
    const viewer = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const shareId = await shareOf(owner.id, bottle.id);

    /**
     * The validation query itself failing — a pool timeout, a reset. It used
     * to run unguarded in the route AFTER `upsertUserBottle` had committed, so
     * this became a 500: the person was told their bottle had not been added
     * when it had, and the retry then found the existing row, so `created` was
     * false and no conversion was recorded either. A lost metric is a
     * nuisance; a successful write reported as a failure is a lie to the user.
     */
    const broken = {
      select: () => {
        throw new Error("connection reset while resolving the share");
      },
    } as unknown as DB;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordShareConversion(broken, {
        shareId,
        bottleId: bottle.id,
        userId: viewer.id,
        relationship: "wishlist",
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("swallows a failed event write too, for the same reason", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      insert: () => {
        throw new Error("table is gone");
      },
    } as unknown as DB;
    await expect(recordEvent(broken, "share_view", { shareId: null })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("telling a crawler from a reader", () => {
  const req = (h: Record<string, string>) => ({
    get: (name: string) => h[name.toLowerCase()] ?? null,
  });

  it("skips the preview crawlers that fetch a share link before anyone reads it", () => {
    // The shares that travel furthest are unfurled the most, so this inflated
    // `views` in proportion to a link's success — the opposite of measuring it.
    for (const ua of [
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "Twitterbot/1.0",
      "WhatsApp/2.23.20.0 A",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "TelegramBot (like TwitterBot)",
      "curl/8.4.0",
      "python-requests/2.31.0",
    ]) {
      expect(isAutomatedFetch(req({ "user-agent": ua }))).toBe(true);
    }
  });

  it("skips speculative fetches that announce themselves", () => {
    expect(isAutomatedFetch(req({ "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(isAutomatedFetch(req({ purpose: "prefetch" }))).toBe(true);
    expect(isAutomatedFetch(req({ "x-purpose": "preview" }))).toBe(true);
    expect(isAutomatedFetch(req({ "x-moz": "prefetch" }))).toBe(true);
  });

  it("never discards a real reader, including the headless browser e2e uses", () => {
    // The heuristic errs towards over-counting on purpose: a crawler that
    // slips through inflates a number that was already inflated, while a
    // dropped reader would silently understate the thing being measured.
    for (const ua of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      // Playwright. Filtering this would make the e2e suite stop exercising
      // the very path it exists to exercise, and nobody would be told.
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
    ]) {
      expect(isAutomatedFetch(req({ "user-agent": ua }))).toBe(false);
    }
    // No headers at all is a reader, not a robot: refusing to count somebody
    // because their client is quiet is the error this must not make.
    expect(isAutomatedFetch(req({}))).toBe(false);
  });
});

describe("writing a pair of funnel events", () => {
  it("lands both rows or neither, so a ratio cannot be skewed by a partial write", async () => {
    const owner = await createTestUser(db);
    const viewer = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const shareId = await shareOf(owner.id, bottle.id);

    await recordEvents(db, [
      { name: "share_view", userId: viewer.id, shareId },
      { name: "share_comparison_rendered", userId: viewer.id, shareId },
    ]);

    const rows = await db.select().from(schema.analyticsEvents);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual([
      "share_comparison_rendered",
      "share_view",
    ]);
  });

  it("swallows a failed write like every other function here", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      insert: () => {
        throw new Error("connection reset");
      },
    } as unknown as DB;

    await expect(
      recordEvents(broken, [
        { name: "share_view", userId: null, shareId: null },
        { name: "share_comparison_rendered", userId: null, shareId: null },
      ]),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("writes nothing for an empty list", async () => {
    await recordEvents(db, []);
    expect(await db.select().from(schema.analyticsEvents)).toHaveLength(0);
  });
});


describe("a telemetry write that fails silently flattens the funnel it feeds", () => {
  let captured: CapturedEvent[];
  beforeEach(() => {
    captured = [];
    setErrorReporterForTests((e) => captured.push(e));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    setErrorReporterForTests(null);
    vi.restoreAllMocks();
  });

  /** Every write in this module goes through db.insert; break just that. */
  function breakInserts(): () => void {
    const real = db.insert.bind(db);
    db.insert = (() => ({
      values: () => Promise.reject(new Error("analytics_events is gone")),
    })) as unknown as typeof db.insert;
    return () => {
      db.insert = real;
    };
  }

  it("reports a single event that cannot be written", async () => {
    const restore = breakInserts();
    try {
      // The contract holds: it does not throw, and the caller is unaffected.
      await expect(recordEvent(db, "share_view")).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(captured.map((e) => e.context.where)).toContain("analytics/recordEvent");
  });

  it("reports a funnel pair that cannot be written", async () => {
    const restore = breakInserts();
    try {
      await expect(
        recordEvents(db, [{ name: "share_view" }, { name: "share_comparison_rendered" }]),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(captured.map((e) => e.context.where)).toContain("analytics/recordEvents");
  });

  it("reports a share code that cannot be resolved", async () => {
    // shareIdForCode answers null on failure, which does not break anything
    // visible: the page still renders and the event still lands, with no share
    // id on it. That is the quietest failure in this file -- the funnel keeps
    // counting and stops meaning what its columns say.
    const realQuery = db.query.pourShares.findFirst;
    db.query.pourShares.findFirst = (() =>
      Promise.reject(new Error("pour_shares is gone"))) as typeof realQuery;
    try {
      await expect(shareIdForCode(db, "whatever")).resolves.toBeNull();
    } finally {
      db.query.pourShares.findFirst = realQuery;
    }
    expect(captured.map((e) => e.context.where)).toContain("analytics/shareIdForCode");
  });

  it("reports a conversion whose own validation query fails", async () => {
    // The validation lives inside this boundary deliberately (see the
    // docstring), which means its failures are inside the silence too.
    const realSelect = db.select.bind(db);
    db.select = (() => ({
      from: () => ({ innerJoin: () => ({ where: () => Promise.reject(new Error("pool timeout")) }) }),
    })) as unknown as typeof db.select;
    try {
      await expect(
        recordShareConversion(db, {
          shareId: uid("share"),
          bottleId: uid("bottle"),
          userId: uid("user"),
          relationship: "wishlist",
        }),
      ).resolves.toBeUndefined();
    } finally {
      db.select = realSelect;
    }
    expect(captured.map((e) => e.context.where)).toContain("analytics/recordShareConversion");
  });
});

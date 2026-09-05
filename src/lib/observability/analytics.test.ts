import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { isAutomatedFetch, recordEvent, recordShareConversion } from "./analytics";

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

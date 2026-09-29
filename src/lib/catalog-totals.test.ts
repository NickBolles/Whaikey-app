import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { approveSubmission, submitBottle } from "@/lib/catalog";
import {
  CATALOG_TOTALS_MAX_AGE_MS,
  getCatalogTotals,
  refreshCatalogTotals,
} from "@/lib/catalog-totals";
import { createTestBottle, createTestUser, setupTestDb } from "@/test/helpers";

let db: DB;

/** The totals counted the slow, obvious way: every verified bottle, in JS. */
async function countedByHand() {
  const rows = await db.select().from(schema.bottles);
  const verified = rows.filter((b) => b.status === "verified");
  const tally = (pick: (b: (typeof verified)[number]) => string | null) => {
    const m = new Map<string, number>();
    for (const b of verified) {
      const v = pick(b);
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return m;
  };
  return {
    country: tally((b) => b.country),
    region: tally((b) => b.region),
    style: tally((b) => b.category),
    all: verified.length,
  };
}

const HOUR = 60 * 60 * 1000;

describe("catalog totals (WP-21)", () => {
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("counts the verified seed catalog by country, region and style", async () => {
    await seedDatabase(db);
    const totals = await getCatalogTotals(db);
    const expected = await countedByHand();
    expect(totals.all).toBe(expected.all);
    expect(totals.all).toBeGreaterThan(200);
    expect(totals.country).toEqual(expected.country);
    expect(totals.region).toEqual(expected.region);
    expect(totals.style).toEqual(expected.style);
  });

  it("leaves out imports, other people's and your own submissions, and blank stamps", async () => {
    const alice = await createTestUser(db);
    await createTestBottle(db, { name: "Counted", country: "Scotland", region: "Islay", category: "scotch-single-malt" });
    await createTestBottle(db, { name: "Imported", status: "imported", country: "Scotland", region: "Islay" });
    await createTestBottle(db, { name: "No Origin", country: null, region: null, category: "world" });
    await submitBottle(db, alice.id, { name: "Pending Pick", category: "bourbon" });

    const totals = await refreshCatalogTotals(db);
    expect(totals.all).toBe(2);
    expect(totals.country).toEqual(new Map([["Scotland", 1]]));
    expect(totals.region).toEqual(new Map([["Islay", 1]]));
    expect(totals.style).toEqual(new Map([["scotch-single-malt", 1], ["world", 1]]));
  });

  it("is written to catalog_totals, one row per stamp plus the catalog size", async () => {
    await createTestBottle(db, { country: "Japan", region: null, category: "japanese" });
    const now = new Date("2026-09-01T12:00:00Z");
    await refreshCatalogTotals(db, now);
    const rows = await db.select().from(schema.catalogTotals);
    expect(rows.map((r) => [r.family, r.value, r.total]).sort()).toEqual(
      [["all", "", 1], ["country", "Japan", 1], ["style", "japanese", 1]].sort(),
    );
    expect(rows.every((r) => r.refreshedAt.getTime() === now.getTime())).toBe(true);
  });

  it("serves the cache inside the max age and recounts once it is older", async () => {
    await createTestBottle(db, { country: "Scotland" });
    const t0 = new Date("2026-09-01T12:00:00Z");
    expect((await getCatalogTotals(db, t0)).all).toBe(1);

    // A write that did not refresh (e.g. catalog verification): within the
    // hour the cache stands — the documented cost of the refresh rule.
    await createTestBottle(db, { country: "Scotland" });
    const within = new Date(t0.getTime() + CATALOG_TOTALS_MAX_AGE_MS - 1);
    expect((await getCatalogTotals(db, within)).all).toBe(1);

    // Past it, the next read recounts before answering, and stores the result.
    const after = new Date(t0.getTime() + CATALOG_TOTALS_MAX_AGE_MS + 1);
    const fresh = await getCatalogTotals(db, after);
    expect(fresh.all).toBe(2);
    expect(fresh.country.get("Scotland")).toBe(2);
    expect(fresh.refreshedAt.getTime()).toBe(after.getTime());
    expect((await getCatalogTotals(db, new Date(after.getTime() + 1))).refreshedAt.getTime()).toBe(after.getTime());
  });

  it("bounds staleness to an hour", () => {
    expect(CATALOG_TOTALS_MAX_AGE_MS).toBeLessThanOrEqual(HOUR);
  });

  it("computes on first read of an empty cache, and an empty catalog still caches", async () => {
    const t0 = new Date("2026-09-01T12:00:00Z");
    const totals = await getCatalogTotals(db, t0);
    expect(totals.all).toBe(0);
    const rows = await db.select().from(schema.catalogTotals);
    expect(rows).toEqual([{ family: "all", value: "", total: 0, refreshedAt: t0 }]);
  });

  it("is refreshed by the seed", async () => {
    await seedDatabase(db);
    const rows = await db.select().from(schema.catalogTotals);
    expect(rows.find((r) => r.family === "all")?.total).toBe((await countedByHand()).all);
  });

  it("is refreshed when a submission is promoted into the catalog", async () => {
    const [alice, operator] = [await createTestUser(db), await createTestUser(db)];
    await createTestBottle(db, { country: "USA", region: "Kentucky", category: "bourbon" });
    const t0 = new Date();
    expect((await getCatalogTotals(db, t0)).all).toBe(1);

    const { submissionId } = await submitBottle(db, alice.id, {
      name: "Alice's Barrel Pick",
      category: "bourbon",
      country: "USA",
      region: "Kentucky",
    });
    // Pending: not in the shared catalog, so not in its totals.
    expect((await getCatalogTotals(db, t0)).all).toBe(1);

    await approveSubmission(db, operator.id, submissionId);
    const totals = await getCatalogTotals(db, t0);
    expect(totals.all).toBe(2);
    expect(totals.region.get("Kentucky")).toBe(2);
  });

  it("never exposes a half-written set to concurrent readers", async () => {
    await seedDatabase(db);
    const expected = await countedByHand();
    const stale = new Date(Date.now() + 2 * CATALOG_TOTALS_MAX_AGE_MS);
    const results = await Promise.all(Array.from({ length: 6 }, () => getCatalogTotals(db, stale)));
    for (const totals of results) {
      expect(totals.all).toBe(expected.all);
      expect(totals.country).toEqual(expected.country);
    }
    const rows = await db.select().from(schema.catalogTotals);
    expect(rows.filter((r) => r.family === "all")).toHaveLength(1);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { seedDatabase } from "@/db/seed";
import { upsertUserBottle } from "@/lib/bar";
import { catalogVisibleTo } from "@/lib/catalog-visibility";
import { cosineSimilarity, priceInBand, type PalateProfileResult, type PriceBand } from "@/lib/palate";
import { getUserPalate, getUserPriceBand } from "@/lib/palate-store";
import { getPassport, type Passport } from "@/lib/passport";
import { badgeProgressFor } from "@/lib/passport-progress";
import { logPour } from "@/lib/pours";
import {
  DISCOVERY_CANDIDATE_LIMIT,
  MAX_RECOMMENDATIONS,
  discoveryCandidates,
  passportBonus,
  recommendBottles,
} from "@/lib/recommend";
import { createTestBottle, createTestUser, setupTestDb } from "@/test/helpers";

/**
 * WP-21 / REL-2.1: discovery moved from "select every visible bottle, filter
 * and score in JS" to a filtered, scored, LIMITed SQL query. These tests hold
 * the new query to the old behaviour on the seed catalog, bottle for bottle.
 */
let db: DB;

interface Scored {
  bottleId: string;
  name: string;
  score: number;
}

/**
 * The discovery candidate pass as it stood before WP-21, kept verbatim as an
 * oracle (src/lib/recommend.ts at 8ecad17): every visible bottle, filtered and
 * scored in JS, then the passport bonus the caller added.
 */
async function legacyDiscovery(
  userId: string,
  palate: PalateProfileResult,
  band: PriceBand | null,
  passport: Passport,
): Promise<Scored[]> {
  const owned = await db
    .select({ bottleId: schema.userBottles.bottleId })
    .from(schema.userBottles)
    .where(eq(schema.userBottles.userId, userId));
  const ownedSet = new Set(owned.map((o) => o.bottleId));
  const rows = await db
    .select({
      bottleId: schema.bottles.id,
      name: schema.bottles.name,
      category: schema.bottles.category,
      region: schema.bottles.region,
      country: schema.bottles.country,
      avgPrice: schema.bottles.avgPrice,
      flavorProfile: schema.bottles.flavorProfile,
    })
    .from(schema.bottles)
    .where(catalogVisibleTo(userId));
  const scored: Scored[] = [];
  for (const b of rows) {
    if (ownedSet.has(b.bottleId)) continue;
    if (!b.flavorProfile || Object.keys(b.flavorProfile).length === 0) continue;
    if (!priceInBand(b.avgPrice, band)) continue;
    const score = cosineSimilarity(palate.vector, b.flavorProfile);
    if (score <= 0) continue;
    scored.push({ bottleId: b.bottleId, name: b.name, score: score + passportBonus(badgeProgressFor(passport, b)) });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

async function newDiscovery(
  userId: string,
  palate: PalateProfileResult,
  band: PriceBand | null,
  passport: Passport,
  limit?: number,
): Promise<Scored[]> {
  const rows = await discoveryCandidates(db, userId, palate, band, passport, limit);
  return rows
    .map((b) => ({ bottleId: b.bottleId, name: b.name, score: b.score + passportBonus(badgeProgressFor(passport, b)) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

async function inputsFor(userId: string) {
  const [palate, band, passport] = await Promise.all([
    getUserPalate(db, userId),
    getUserPriceBand(db, userId),
    getPassport(db, userId),
  ]);
  return { palate, band, passport };
}

/** Three drinkers with different palates, shelves and price bands. */
async function seedDrinkers() {
  const peat = await createTestUser(db);
  for (const [bottleId, rating] of [["laphroaig-10", 5], ["lagavulin-16", 4.5], ["ardbeg-10", 5], ["jameson", 2]] as const) {
    await logPour(db, peat.id, { bottleId, rating });
  }
  await upsertUserBottle(db, peat.id, { bottleId: "talisker-10", relationship: "wishlist" });

  const bourbon = await createTestUser(db);
  for (const [bottleId, rating] of [["buffalo-trace", 4], ["eagle-rare-10", 5], ["weller-special-reserve", 4.5]] as const) {
    await logPour(db, bourbon.id, { bottleId, rating });
  }
  // A shelf with prices gives this drinker a price band to filter by.
  for (const [bottleId, purchasePrice] of [["buffalo-trace", 30], ["eagle-rare-10", 45], ["makers-mark", 32]] as const) {
    await upsertUserBottle(db, bourbon.id, { bottleId, relationship: "own", purchasePrice });
  }

  const sampler = await createTestUser(db);
  for (const [bottleId, rating] of [["hibiki-harmony", 4], ["redbreast-12", 3.5]] as const) {
    await logPour(db, sampler.id, { bottleId, rating });
  }
  return { peat, bourbon, sampler };
}

describe("discovery candidates in SQL (WP-21)", () => {
  beforeEach(async () => {
    db = await setupTestDb();
    await seedDatabase(db);
  });

  it("returns the old implementation's candidates, in order and with the same scores, on the seed catalog", async () => {
    // The equivalence claim is about the seed, which holds no imports — the
    // one intended difference (below).
    const imported = await db.select().from(schema.bottles).where(eq(schema.bottles.status, "imported"));
    expect(imported).toEqual([]);

    const drinkers = await seedDrinkers();
    let comparedWithBand = false;
    for (const user of Object.values(drinkers)) {
      const { palate, band, passport } = await inputsFor(user.id);
      expect(palate.sampleSize).toBeGreaterThan(0);
      if (band) comparedWithBand = true;

      const legacy = await legacyDiscovery(user.id, palate, band, passport);
      const next = await newDiscovery(user.id, palate, band, passport);
      expect(next.length).toBe(Math.min(legacy.length, DISCOVERY_CANDIDATE_LIMIT));
      expect(next.map((c) => c.bottleId)).toEqual(legacy.slice(0, next.length).map((c) => c.bottleId));
      next.forEach((c, i) => expect(c.score).toBeCloseTo(legacy[i].score, 12));

      // And with no band at all, which widens the pool to the whole catalog.
      const legacyAll = await legacyDiscovery(user.id, palate, null, passport);
      const nextAll = await newDiscovery(user.id, palate, null, passport);
      expect(nextAll.map((c) => c.bottleId)).toEqual(legacyAll.slice(0, nextAll.length).map((c) => c.bottleId));
    }
    // Otherwise the band filter was never exercised by the comparison.
    expect(comparedWithBand).toBe(true);
  });

  it("gives recommendBottles the same final list the unbounded pass would have", async () => {
    const drinkers = await seedDrinkers();
    for (const user of Object.values(drinkers)) {
      const { palate, band, passport } = await inputsFor(user.id);
      const legacy = await legacyDiscovery(user.id, palate, band, passport);
      const recs = await recommendBottles(db, user.id, { mode: "discovery", limit: MAX_RECOMMENDATIONS });
      expect(recs.map((r) => r.bottleId)).toEqual(legacy.slice(0, MAX_RECOMMENDATIONS).map((c) => c.bottleId));
    }
  });

  it("honours its LIMIT, and a short LIMIT is still the top of the full ranking", async () => {
    const { peat } = await seedDrinkers();
    const { palate, band, passport } = await inputsFor(peat.id);
    const legacy = await legacyDiscovery(peat.id, palate, null, passport);
    expect(legacy.length).toBeGreaterThan(DISCOVERY_CANDIDATE_LIMIT);

    expect(await discoveryCandidates(db, peat.id, palate, null, passport)).toHaveLength(DISCOVERY_CANDIDATE_LIMIT);
    const five = await newDiscovery(peat.id, palate, band, passport, 5);
    const legacyBand = await legacyDiscovery(peat.id, palate, band, passport);
    expect(five.map((c) => c.bottleId)).toEqual(legacyBand.slice(0, 5).map((c) => c.bottleId));
  });

  it("stays exact when a passport bonus outranks a better palate match", async () => {
    // With a limit of one, SQL must return the bottle the passport bonus lifts
    // to the top, not the best raw palate match — which is why the bonus is in
    // the SQL ordering rather than added to whatever comes back.
    const { peat } = await seedDrinkers();
    const { palate, passport } = await inputsFor(peat.id);
    const perfect = Object.fromEntries(
      Object.entries(palate.vector).map(([k, v]) => [k, Math.round(Math.max(0, v) * 100) / 10]),
    );
    const nearly = { ...perfect, grain: (perfect.grain ?? 0) + 1.5 };
    // Islay, Scotland, single malt: every stamp already held, so no bonus.
    const familiar = await createTestBottle(db, {
      name: "Familiar Islay Match",
      category: "scotch-single-malt",
      country: "Scotland",
      region: "Islay",
      avgPrice: null,
      flavorProfile: perfect,
    });
    // A country this drinker has never met opens a badge.
    const faraway = await createTestBottle(db, {
      name: "Faraway Near Match",
      category: "world",
      country: "Iceland",
      region: null,
      avgPrice: null,
      flavorProfile: nearly,
    });
    const rawFamiliar = cosineSimilarity(palate.vector, perfect);
    const rawFaraway = cosineSimilarity(palate.vector, nearly);
    expect(rawFamiliar).toBeGreaterThan(rawFaraway);
    expect(passportBonus(badgeProgressFor(passport, familiar))).toBe(0);
    expect(rawFaraway + passportBonus(badgeProgressFor(passport, faraway))).toBeGreaterThan(rawFamiliar);

    const [top] = await newDiscovery(peat.id, palate, null, passport, 1);
    expect(top.bottleId).toBe(faraway.id);
    const legacy = await legacyDiscovery(peat.id, palate, null, passport);
    expect(legacy[0].bottleId).toBe(faraway.id);
  });

  it("excludes every shelf relationship, wishlist included", async () => {
    const { peat } = await seedDrinkers();
    const { palate, passport } = await inputsFor(peat.id);
    const ids = (await discoveryCandidates(db, peat.id, palate, null, passport)).map((c) => c.bottleId);
    for (const shelved of ["laphroaig-10", "lagavulin-16", "ardbeg-10", "talisker-10"]) {
      expect(ids).not.toContain(shelved);
    }
  });

  it("keeps an unpriced bottle when filtering by price band, as priceInBand always has", async () => {
    const { bourbon } = await seedDrinkers();
    const { palate, band, passport } = await inputsFor(bourbon.id);
    expect(band).not.toBeNull();
    const unpriced = await createTestBottle(db, {
      name: "Unpriced Wheater",
      avgPrice: null,
      flavorProfile: { sweet: 9, woody: 7, fruity: 5, spicy: 3, grain: 2 },
    });
    const pricey = await createTestBottle(db, {
      name: "Allocated Wheater",
      avgPrice: 5000,
      flavorProfile: { sweet: 9, woody: 7, fruity: 5, spicy: 3, grain: 2 },
    });
    const ids = (await discoveryCandidates(db, bourbon.id, palate, band, passport)).map((c) => c.bottleId);
    expect(ids).toContain(unpriced.id);
    expect(ids).not.toContain(pricey.id);
  });

  it("recommends from the verified catalog: an unvetted import never, however good the match", async () => {
    // The one intended change (REL-2.1): the rail and the passport now agree
    // about what the catalog is.
    const { peat } = await seedDrinkers();
    const { palate, passport } = await inputsFor(peat.id);
    const perfect = Object.fromEntries(Object.entries(palate.vector).map(([k, v]) => [k, Math.max(0, v) * 10]));
    const imported = await createTestBottle(db, { name: "Imported Peat Bomb", status: "imported", flavorProfile: perfect });
    const verified = await createTestBottle(db, { name: "Verified Peat Bomb", status: "verified", flavorProfile: perfect });
    const ids = (await discoveryCandidates(db, peat.id, palate, null, passport)).map((c) => c.bottleId);
    expect(ids).not.toContain(imported.id);
    expect(ids[0]).toBe(verified.id);
  });

  it("returns nothing for a palate with no direction, without querying the catalog", async () => {
    const user = await createTestUser(db);
    const passport = await getPassport(db, user.id);
    const flat: PalateProfileResult = {
      ...(await getUserPalate(db, user.id)),
      vector: {},
      sampleSize: 1,
    };
    expect(await discoveryCandidates(db, user.id, flat, null, passport)).toEqual([]);
  });

  it("survives a profile value that is not a number instead of failing the whole rail", async () => {
    // The column is typed as numbers, but it is jsonb and written by ingest.
    // A bare `::float8` cast would throw on "lots" and take every user's rail
    // down with one bad row; the SQL reads it as 0, and a NaN score from the
    // JS cosine is dropped rather than sorted.
    const { peat } = await seedDrinkers();
    const { palate, passport } = await inputsFor(peat.id);
    await createTestBottle(db, {
      name: "Odd Profile",
      flavorProfile: { peaty: "lots" as unknown as number, woody: 6 },
    });
    const rows = await discoveryCandidates(db, peat.id, palate, null, passport, 1000);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Number.isFinite(row.score)).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { buildReason, recommendBottles, type Recommendation } from "./recommend";
import { getUserPalate } from "./palate-store";

let db: DB;
let userId: string;

beforeEach(async () => {
  db = await setupTestDb();
  const user = await createTestUser(db);
  userId = user.id;
});

/** Insert a pour (+ optional note tags) so the user builds a palate. */
async function logPour(
  bottleId: string,
  rating: number,
  flavorTags?: Record<string, number>,
): Promise<void> {
  const pourId = uid("pour");
  await db.insert(schema.pours).values({ id: pourId, userId, bottleId, rating });
  if (flavorTags) {
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId,
      flavorTags,
    });
  }
}

async function own(
  bottleId: string,
  overrides: Partial<schema.UserBottle> = {},
): Promise<string> {
  const id = uid("ub");
  await db.insert(schema.userBottles).values({
    id,
    userId,
    bottleId,
    relationship: overrides.relationship ?? "own",
    ...overrides,
  });
  return id;
}

describe("recommendBottles — discovery", () => {
  it("returns [] when the user has no pours (no palate signal)", async () => {
    await createTestBottle(db, { flavorProfile: { peaty: 9, woody: 5 } });
    const recs = await recommendBottles(db, userId, { mode: "discovery" });
    expect(recs).toEqual([]);
  });

  it("ranks a profile-aligned bottle above a misaligned one and excludes owned", async () => {
    // Build a smoky/woody palate from a highly-rated peated pour.
    const drunk = await createTestBottle(db, {
      name: "Poured Islay",
      flavorProfile: { peaty: 9, woody: 6 },
    });
    await logPour(drunk.id, 5, { campfire: 3, oak: 2 });

    const aligned = await createTestBottle(db, {
      name: "Smoky Match",
      flavorProfile: { peaty: 9, woody: 5 },
      avgPrice: 60,
    });
    const misaligned = await createTestBottle(db, {
      name: "Sweet Mismatch",
      flavorProfile: { sweet: 9, fruity: 7, woody: 2 },
      avgPrice: 60,
    });
    // Owned bottle that would otherwise rank high must be excluded.
    const owned = await createTestBottle(db, {
      name: "Owned Smoky",
      flavorProfile: { peaty: 9, woody: 6 },
      avgPrice: 60,
    });
    await own(owned.id, { relationship: "wishlist" });

    const recs = await recommendBottles(db, userId, { mode: "discovery" });
    const ids = recs.map((r) => r.bottleId);

    expect(ids).toContain(aligned.id);
    expect(ids).not.toContain(owned.id); // excluded (any relationship)
    // aligned outranks misaligned
    const alignedIdx = ids.indexOf(aligned.id);
    const misIdx = ids.indexOf(misaligned.id);
    expect(alignedIdx).toBeGreaterThanOrEqual(0);
    expect(alignedIdx).toBeLessThan(misIdx);
    expect(recs[alignedIdx].matchPercent).toBeGreaterThan(0);
  });

  it("filters out a wildly-priced bottle outside the user's price band", async () => {
    const drunk = await createTestBottle(db, { flavorProfile: { peaty: 9, woody: 6 } });
    await logPour(drunk.id, 5, { campfire: 3 });
    // Establish a price band around $60 from an owned purchase.
    const bandBottle = await createTestBottle(db, { name: "Band Anchor", flavorProfile: { sweet: 5 } });
    await own(bandBottle.id, { relationship: "own", purchasePrice: 60 });

    const inBand = await createTestBottle(db, {
      name: "In Band Smoky",
      flavorProfile: { peaty: 9, woody: 5 },
      avgPrice: 60,
    });
    const tooPricey = await createTestBottle(db, {
      name: "Grail Smoky",
      flavorProfile: { peaty: 9, woody: 5 },
      avgPrice: 5000,
    });

    const recs = await recommendBottles(db, userId, { mode: "discovery" });
    const ids = recs.map((r) => r.bottleId);
    expect(ids).toContain(inBand.id);
    expect(ids).not.toContain(tooPricey.id);
  });

  it("carries a grounded, non-empty deterministic reason", async () => {
    const drunk = await createTestBottle(db, { flavorProfile: { peaty: 9, woody: 6 } });
    await logPour(drunk.id, 5, { campfire: 3, oak: 2 });
    await createTestBottle(db, {
      name: "Smoky Match",
      flavorProfile: { peaty: 9, woody: 5 },
      avgPrice: 60,
    });

    const recs = await recommendBottles(db, userId, { mode: "discovery" });
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].reason.length).toBeGreaterThan(0);
    expect(recs[0].reason).toMatch(/smoky|woody|palate/i);
  });
});

describe("recommendBottles — tonight", () => {
  it("only returns the user's own OPEN bottles", async () => {
    const drunk = await createTestBottle(db, { flavorProfile: { sweet: 8, woody: 5 } });
    await logPour(drunk.id, 5);

    const openBottle = await createTestBottle(db, {
      name: "Open One",
      flavorProfile: { sweet: 8, woody: 5 },
    });
    const sealedBottle = await createTestBottle(db, {
      name: "Sealed One",
      flavorProfile: { sweet: 8, woody: 5 },
    });
    const notOwned = await createTestBottle(db, {
      name: "Catalog Only",
      flavorProfile: { sweet: 8, woody: 5 },
    });
    await own(openBottle.id, { status: "open", fillLevel: 70 });
    await own(sealedBottle.id, { status: "sealed" });
    void notOwned;

    const recs = await recommendBottles(db, userId, { mode: "tonight" });
    const ids = recs.map((r) => r.bottleId);
    expect(ids).toEqual([openBottle.id]);
    expect(recs[0].status).toBe("open");
    expect(recs[0].userBottleId).toBeTruthy();
  });

  it("nudges a nearly-empty bottle above a full one of similar match (kill-list bias)", async () => {
    const drunk = await createTestBottle(db, { flavorProfile: { sweet: 8, woody: 5 } });
    await logPour(drunk.id, 5);

    const nearlyEmpty = await createTestBottle(db, {
      name: "Almost Gone",
      flavorProfile: { sweet: 8, woody: 5 },
    });
    const full = await createTestBottle(db, {
      name: "Brand New",
      flavorProfile: { sweet: 8, woody: 5 },
    });
    await own(nearlyEmpty.id, { status: "open", fillLevel: 12 });
    await own(full.id, { status: "open", fillLevel: 100 });

    const recs = await recommendBottles(db, userId, { mode: "tonight" });
    const ids = recs.map((r) => r.bottleId);
    expect(ids.indexOf(nearlyEmpty.id)).toBeLessThan(ids.indexOf(full.id));
    // The low-fill reason references finishing it.
    const emptyRec = recs.find((r) => r.bottleId === nearlyEmpty.id)!;
    expect(emptyRec.reason).toMatch(/left|finish/i);
  });
});

describe("buildReason", () => {
  it("builds a discovery reason grounded in top wedges and price band", async () => {
    const drunk = await createTestBottle(db, { flavorProfile: { peaty: 9, woody: 6 } });
    await logPour(drunk.id, 5, { campfire: 3, oak: 2 });
    const palate = await getUserPalate(db, userId);

    const rec: Recommendation = {
      bottleId: "b",
      name: "X",
      distillery: null,
      category: "scotch-single-malt",
      region: null,
      ageYears: null,
      avgPrice: 60,
      matchPercent: 88,
      reason: "",
    };
    const reason = buildReason("discovery", rec, palate.vector, {
      band: { min: 50, max: 70, median: 60 },
    });
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toMatch(/\$50–70/);
  });

  it("builds a tonight reason that flags a nearly-empty bottle", () => {
    const rec: Recommendation = {
      bottleId: "b",
      name: "X",
      distillery: null,
      category: "bourbon",
      region: null,
      ageYears: null,
      avgPrice: null,
      matchPercent: 70,
      reason: "",
      fillLevel: 10,
    };
    const reason = buildReason("tonight", rec, {}, { band: null });
    expect(reason).toMatch(/10%/);
    expect(reason).toMatch(/finish|fade/i);
  });
});

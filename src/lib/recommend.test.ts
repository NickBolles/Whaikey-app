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

describe("recommendBottles — taste twins (US-16)", () => {
  /** A followee with a palate of their own, visible to the viewer. */
  async function twinWhoLikes(
    handle: string,
    bottleId: string,
    rating: number,
    visibility: schema.PourVisibility = "public",
  ): Promise<string> {
    const twin = await createTestUser(db);
    await db.insert(schema.userProfiles).values({
      userId: twin.id,
      handle,
      displayName: handle,
      isPublic: true,
      socialEnabled: true,
    });
    await db.insert(schema.follows).values({
      id: uid("f"),
      followerId: userId,
      followeeId: twin.id,
      state: "accepted",
    });
    // Their own palate, leaning the same way as the viewer's below.
    const theirLove = await createTestBottle(db, { name: uid("twin-b"), flavorProfile: { peaty: 9 } });
    for (let i = 0; i < 3; i++) {
      await db
        .insert(schema.pours)
        .values({ id: uid("pour"), userId: twin.id, bottleId: theirLove.id, rating: 5 });
    }
    await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: twin.id, bottleId, rating, visibility });
    return twin.id;
  }

  /** Give the viewer a peaty palate over a bottle they already own. */
  async function peatyViewer(): Promise<void> {
    const owned = await createTestBottle(db, { name: "Owned Peat", flavorProfile: { peaty: 9 } });
    await own(owned.id);
    await logPour(owned.id, 5);
    await logPour(owned.id, 5);
    await logPour(owned.id, 5);
  }

  it("cites the twin who rated it, with the match that earned the mention", async () => {
    await peatyViewer();
    const candidate = await createTestBottle(db, { name: "Twin Pick", flavorProfile: { peaty: 8 } });
    await twinWhoLikes("sasha", candidate.id, 4.5);

    const recs = await recommendBottles(db, userId, { mode: "discovery" });
    const pick = recs.find((r) => r.bottleId === candidate.id);
    expect(pick).toBeDefined();
    expect(pick!.reason).toMatch(/^@sasha, a \d+% palate match, rated it 4\.5\.$/);
  });

  it("counts more than one endorsing twin without naming them all", async () => {
    await peatyViewer();
    const candidate = await createTestBottle(db, { name: "Group Pick", flavorProfile: { peaty: 8 } });
    await twinWhoLikes("sasha", candidate.id, 5);
    await twinWhoLikes("riley", candidate.id, 4);

    const recs = await recommendBottles(db, userId, { mode: "discovery" });
    const pick = recs.find((r) => r.bottleId === candidate.id)!;
    // A threshold every endorser cleared — the lower of 5.0 and 4.0 — rather
    // than pinning the best score on the whole group.
    expect(pick.reason).toBe("2 people who taste like you rated it 4.0+.");
  });

  it("never quotes a rating the named twin did not give", async () => {
    await peatyViewer();
    const candidate = await createTestBottle(db, { name: "Split Pick", flavorProfile: { peaty: 8 } });
    // The higher rating comes from the FURTHER twin; the reason must not
    // attribute it, directly or by implication, to the closer one.
    await twinWhoLikes("closer", candidate.id, 4);
    await twinWhoLikes("further", candidate.id, 5);

    const recs = await recommendBottles(db, userId, { mode: "discovery" });
    const pick = recs.find((r) => r.bottleId === candidate.id)!;
    expect(pick.reason).not.toMatch(/@closer.*5\.0/);
    expect(pick.reason).toContain("4.0+");
  });

  it("promotes an endorsed pick in tonight mode, where scores can go negative", async () => {
    // Tonight scores are match + killBias - varietyPenalty and are never
    // floored at zero, so a multiplier would push a negative score further
    // down and demote the very bottle it meant to promote.
    const openBackedBottle = await createTestBottle(db, {
      name: "Backed Open",
      flavorProfile: { peaty: 9 },
    });
    const openPlainBottle = await createTestBottle(db, {
      name: "Plain Open",
      flavorProfile: { peaty: 9 },
    });
    await own(openBackedBottle.id, { status: "open", fillLevel: 80 });
    await own(openPlainBottle.id, { status: "open", fillLevel: 80 });
    await logPour(openBackedBottle.id, 5);
    await logPour(openPlainBottle.id, 5);
    await logPour(openPlainBottle.id, 5);
    await twinWhoLikes("sasha", openBackedBottle.id, 5);

    const recs = await recommendBottles(db, userId, { mode: "tonight" });
    const order = recs.map((r) => r.bottleId);
    expect(order).toContain(openBackedBottle.id);
    expect(order.indexOf(openBackedBottle.id)).toBeLessThanOrEqual(
      order.indexOf(openPlainBottle.id),
    );
  });

  it("never cites a twin's private pour, falling back to the palate reason", async () => {
    await peatyViewer();
    const candidate = await createTestBottle(db, { name: "Quiet Pick", flavorProfile: { peaty: 8 } });
    await twinWhoLikes("sasha", candidate.id, 5, "private");

    const recs = await recommendBottles(db, userId, { mode: "discovery" });
    const pick = recs.find((r) => r.bottleId === candidate.id)!;
    expect(pick.reason).not.toMatch(/sasha/);
    expect(pick.reason).toMatch(/Leans into your taste|close match/i);
  });

  it("lifts an endorsed bottle over a near neighbour it was behind", async () => {
    await peatyViewer();
    // Scored fractionally higher by palate alone, but nobody vouches for it.
    const unbacked = await createTestBottle(db, { name: "AAA Unbacked", flavorProfile: { peaty: 9 } });
    const backed = await createTestBottle(db, { name: "ZZZ Backed", flavorProfile: { peaty: 8, woody: 1 } });
    await twinWhoLikes("sasha", backed.id, 5);

    const recs = await recommendBottles(db, userId, { mode: "discovery" });
    const order = recs.map((r) => r.bottleId);
    expect(order.indexOf(backed.id)).toBeLessThan(order.indexOf(unbacked.id));
  });

  it("recommends nothing new on a twin's word alone", async () => {
    await peatyViewer();
    // A twin loves it, but it is nothing like the viewer's palate.
    const offPalate = await createTestBottle(db, { name: "Off Palate", flavorProfile: { floral: 9 } });
    await twinWhoLikes("sasha", offPalate.id, 5);

    const recs = await recommendBottles(db, userId, { mode: "discovery" });
    expect(recs.map((r) => r.bottleId)).not.toContain(offPalate.id);
  });
});

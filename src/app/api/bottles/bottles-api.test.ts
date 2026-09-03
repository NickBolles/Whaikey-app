import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import {
  setupTestDb,
  createTestBottle,
  createTestUser,
  setSessionUser,
  uid,
} from "@/test/helpers";
import { GET as searchGET } from "@/app/api/bottles/search/route";
import { GET as detailGET } from "@/app/api/bottles/[id]/route";

vi.mock("@/lib/session", async () => {
  const { mockSessionModule } = await import("@/test/helpers");
  return mockSessionModule();
});

let db: DB;

function searchRequest(qs: string): Request {
  return new Request(`http://localhost:3000/api/bottles/search${qs}`, { method: "GET" });
}

function detailCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/bottles/search", () => {
  beforeEach(async () => {
    db = await setupTestDb();
    setSessionUser(null);
  });

  it("returns 200 with the documented result shape", async () => {
    const [dist] = await db
      .insert(schema.distilleries)
      .values({ id: uid("dist"), name: "Buffalo Trace", country: "USA" })
      .returning();
    await createTestBottle(db, {
      name: "Eagle Rare 10 Year",
      category: "bourbon",
      distilleryId: dist.id,
      ageYears: 10,
      abv: 45,
      avgPrice: 49.99,
    });

    const res = await searchGET(searchRequest("?q=eagle"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      name: "Eagle Rare 10 Year",
      category: "bourbon",
      distillery: "Buffalo Trace",
      ageYears: 10,
      abv: 45,
      avgPrice: 49.99,
    });
    expect(body.results[0]).toHaveProperty("id");
    expect(body.results[0]).toHaveProperty("region");
    expect(body.results[0]).toHaveProperty("flavorProfile");
  });

  it("returns popular bottles (alphabetical) for an empty q", async () => {
    await createTestBottle(db, { name: "Bravo Bourbon" });
    await createTestBottle(db, { name: "Alpha Bourbon" });

    const res = await searchGET(searchRequest(""));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { name: string }) => r.name)).toEqual([
      "Alpha Bourbon",
      "Bravo Bourbon",
    ]);
  });

  it("filters by a valid category", async () => {
    await createTestBottle(db, { name: "Lagavulin 16", category: "scotch-single-malt" });
    await createTestBottle(db, { name: "Lagavulin Fake Bourbon", category: "bourbon" });

    const res = await searchGET(searchRequest("?q=lagavulin&category=scotch-single-malt"));
    const body = await res.json();
    expect(body.results.map((r: { name: string }) => r.name)).toEqual(["Lagavulin 16"]);
  });

  it("rejects an invalid category with 400", async () => {
    const res = await searchGET(searchRequest("?q=eagle&category=tequila"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

/**
 * A rater who has published this pour: a social-enabled profile plus a pour
 * marked public. Both are required — `visibility` is the choice made when
 * logging, `socialEnabled` is the step-back switch that withdraws it.
 */
async function publicRater(db: DB, bottleId: string, rating: number): Promise<schema.User> {
  const user = await createTestUser(db);
  await db.insert(schema.userProfiles).values({
    userId: user.id,
    handle: `h${user.id.slice(-8)}`,
    displayName: "Taster",
    isPublic: true,
    socialEnabled: true,
  });
  await db
    .insert(schema.pours)
    .values({ id: uid("pour"), userId: user.id, bottleId, rating, visibility: "public" });
  return user;
}

describe("GET /api/bottles/[id]", () => {
  beforeEach(async () => {
    db = await setupTestDb();
    setSessionUser(null);
  });

  it("returns 404 for an unknown bottle id", async () => {
    const res = await detailGET(searchRequest(""), detailCtx("nope_missing"));
    expect(res.status).toBe(404);
  });

  it("returns the bottle with distillery, community stats and pairings (signed out)", async () => {
    const [dist] = await db
      .insert(schema.distilleries)
      .values({ id: uid("dist"), name: "Heaven Hill", country: "USA", region: "Kentucky" })
      .returning();
    const bottle = await createTestBottle(db, {
      name: "Elijah Craig Barrel Proof",
      distilleryId: dist.id,
    });
    // Ratings come from OTHER users' pours — community stats span all users —
    // but only the pours those users chose to publish, and only once enough
    // distinct people have published one (SEC-M2).
    const alice = await publicRater(db, bottle.id, 4);
    const bob = await publicRater(db, bottle.id, 5);
    await publicRater(db, bottle.id, 4.5);
    // Unrated pour must not drag the average or the rated count.
    await db.insert(schema.pours).values({
      id: uid("pour"),
      userId: bob.id,
      bottleId: bottle.id,
      rating: null,
      visibility: "public",
    });
    void alice;
    await db.insert(schema.pairings).values({
      id: uid("pairing"),
      bottleId: bottle.id,
      pairingType: "food",
      suggestion: "Dark chocolate",
      rationale: "Stands up to the proof.",
    });
    await db.insert(schema.catalogSources).values({
      id: "heaven-hill-official",
      name: "Heaven Hill",
      kind: "official",
      baseUrl: "https://heavenhilldistillery.com",
      fetchPolicy: "structured",
      mediaPolicy: "display_remote",
    });
    await db.insert(schema.bottleResources).values({
      id: "ecbp-official",
      bottleId: bottle.id,
      sourceId: "heaven-hill-official",
      resourceType: "official_product",
      url: "https://heavenhilldistillery.com/elijah-craig-barrel-proof",
      title: "Elijah Craig Barrel Proof",
      retrievedAt: new Date("2026-08-18T00:00:00Z"),
    });
    await db.insert(schema.bottleClaims).values({
      id: "ecbp-abv-claim",
      bottleId: bottle.id,
      resourceId: "ecbp-official",
      field: "abv",
      value: 65.2,
      valueHash: "abv-hash",
      status: "accepted",
    });
    await db.insert(schema.bottleMedia).values({
      id: "ecbp-image",
      bottleId: bottle.id,
      resourceId: "ecbp-official",
      kind: "bottle",
      url: "https://heavenhilldistillery.com/images/ecbp.png",
      rights: "display_remote",
      attribution: "Heaven Hill",
      isPrimary: true,
    });

    const res = await detailGET(searchRequest(""), detailCtx(bottle.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bottle).toMatchObject({ id: bottle.id, name: "Elijah Craig Barrel Proof" });
    expect(body.distillery).toMatchObject({ name: "Heaven Hill" });
    expect(body.communityStats).toEqual({ avgRating: 4.5, ratingCount: 3, raterCount: 3 });
    expect(body.userBottle).toBeNull();
    expect(body.pairings).toHaveLength(1);
    expect(body.pairings[0]).toMatchObject({ pairingType: "food", suggestion: "Dark chocolate" });
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]).toMatchObject({
      resourceType: "official_product",
      source: { name: "Heaven Hill", kind: "official" },
    });
    expect(body.claims).toEqual([expect.objectContaining({ field: "abv", value: 65.2, status: "accepted" })]);
    expect(body.media).toEqual([expect.objectContaining({ kind: "bottle", rights: "display_remote" })]);
  });

  it("hides disabled sources and non-displayable claims/media from public details", async () => {
    const bottle = await createTestBottle(db, { id: "hidden-provenance" });
    await db.insert(schema.catalogSources).values({
      id: "disabled-public-source",
      name: "Disabled source",
      kind: "registry",
      baseUrl: "https://registry.example",
      fetchPolicy: "structured",
      mediaPolicy: "review_required",
      enabled: false,
    });
    await db.insert(schema.bottleResources).values({
      id: "disabled-public-resource",
      bottleId: bottle.id,
      sourceId: "disabled-public-source",
      resourceType: "registry",
      url: "https://registry.example/item",
      retrievedAt: new Date(),
    });
    await db.insert(schema.bottleClaims).values({
      id: "disabled-public-claim",
      bottleId: bottle.id,
      resourceId: "disabled-public-resource",
      field: "abv",
      value: 99,
      valueHash: "disabled-abv",
      status: "review_required",
    });
    await db.insert(schema.bottleMedia).values({
      id: "disabled-public-media",
      bottleId: bottle.id,
      resourceId: "disabled-public-resource",
      kind: "bottle",
      url: "https://registry.example/image.png",
      rights: "review_required",
    });
    await db.insert(schema.catalogSources).values({
      id: "enabled-review-source",
      name: "Enabled review source",
      kind: "editorial",
      baseUrl: "https://reviews.example",
      fetchPolicy: "structured",
      mediaPolicy: "review_required",
      enabled: true,
    });
    await db.insert(schema.bottleResources).values({
      id: "enabled-review-resource",
      bottleId: bottle.id,
      sourceId: "enabled-review-source",
      resourceType: "review",
      url: "https://reviews.example/item",
      retrievedAt: new Date(),
    });
    await db.insert(schema.bottleClaims).values({
      id: "enabled-review-claim",
      bottleId: bottle.id,
      resourceId: "enabled-review-resource",
      field: "reviewScore",
      value: 99,
      valueHash: "enabled-review-score",
      status: "review_required",
    });
    await db.insert(schema.bottleMedia).values({
      id: "enabled-review-media",
      bottleId: bottle.id,
      resourceId: "enabled-review-resource",
      kind: "bottle",
      url: "https://reviews.example/image.png",
      rights: "review_required",
    });

    const res = await detailGET(searchRequest(""), detailCtx(bottle.id));
    const body = await res.json();
    expect(body.resources).toEqual([
      expect.objectContaining({ id: "enabled-review-resource" }),
    ]);
    expect(body.claims).toEqual([]);
    expect(body.media).toEqual([]);
  });

  it("applies the most restrictive enabled policy across source-specific media associations", async () => {
    const bottle = await createTestBottle(db, { id: "conflicting-media-rights" });
    await db.insert(schema.catalogSources).values([
      { id: "display-media-source", name: "Display", kind: "official", baseUrl: "https://display.example", fetchPolicy: "structured", mediaPolicy: "display_remote" },
      { id: "restricted-media-source", name: "Restricted", kind: "editorial", baseUrl: "https://restricted.example", fetchPolicy: "structured", mediaPolicy: "review_required" },
    ]);
    await db.insert(schema.bottleResources).values([
      { id: "display-media-resource", bottleId: bottle.id, sourceId: "display-media-source", resourceType: "official_product", url: "https://display.example/item", retrievedAt: new Date() },
      { id: "restricted-media-resource", bottleId: bottle.id, sourceId: "restricted-media-source", resourceType: "review", url: "https://restricted.example/item", retrievedAt: new Date() },
    ]);
    const sharedUrl = "https://cdn.example/shared.png";
    await db.insert(schema.bottleMedia).values([
      { id: "display-media", bottleId: bottle.id, resourceId: "display-media-resource", kind: "bottle", url: sharedUrl, rights: "display_remote" },
      { id: "restricted-media", bottleId: bottle.id, resourceId: "restricted-media-resource", kind: "bottle", url: sharedUrl, rights: "review_required" },
    ]);

    const res = await detailGET(searchRequest(""), detailCtx(bottle.id));
    expect((await res.json()).media).toEqual([]);
  });

  it("includes the signed-in user's shelf relationship", async () => {
    const bottle = await createTestBottle(db);
    const me = await createTestUser(db);
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: me.id,
      bottleId: bottle.id,
      relationship: "own",
      status: "open",
    });
    setSessionUser(me);

    const res = await detailGET(searchRequest(""), detailCtx(bottle.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userBottle).toMatchObject({ relationship: "own", status: "open" });
  });

  it("does not leak another user's shelf row", async () => {
    const bottle = await createTestBottle(db);
    const other = await createTestUser(db);
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: other.id,
      bottleId: bottle.id,
      relationship: "wishlist",
    });
    const me = await createTestUser(db);
    setSessionUser(me);

    const res = await detailGET(searchRequest(""), detailCtx(bottle.id));
    const body = await res.json();
    expect(body.userBottle).toBeNull();
  });
});

/**
 * SEC-M2. `/api/bottles/[id]` needs no session, so its community average is
 * readable by anyone with the id — and it was computed over every pour,
 * including ones the owner marked "Only me". On a rarely-rated bottle, watching
 * that number move told an unauthenticated poller the rating and the timing of
 * a single private pour, which is the opposite of what docs/SOCIAL.md promises.
 */
describe("GET /api/bottles/[id] community rating privacy", () => {
  let bottle: schema.Bottle;

  beforeEach(async () => {
    db = await setupTestDb();
    setSessionUser(null);
    bottle = await createTestBottle(db, { name: "Elijah Craig Barrel Proof" });
  });

  async function stats() {
    const res = await detailGET(searchRequest(""), detailCtx(bottle.id));
    return (await res.json()).communityStats;
  }

  it("never lets a private pour move the public average", async () => {
    await publicRater(db, bottle.id, 4);
    await publicRater(db, bottle.id, 4);
    await publicRater(db, bottle.id, 4);
    expect(await stats()).toEqual({ avgRating: 4, ratingCount: 3, raterCount: 3 });

    // A 1-star pour kept to oneself. The number must not budge.
    const quiet = await publicRater(db, bottle.id, 4);
    await db.insert(schema.pours).values({
      id: uid("pour"),
      userId: quiet.id,
      bottleId: bottle.id,
      rating: 1,
      visibility: "private",
    });
    expect(await stats()).toEqual({ avgRating: 4, ratingCount: 4, raterCount: 4 });
  });

  it("drops the pours of someone who has stepped back from social", async () => {
    await publicRater(db, bottle.id, 4);
    await publicRater(db, bottle.id, 4);
    const leaving = await publicRater(db, bottle.id, 1);
    expect((await stats()).raterCount).toBe(3);

    // "Make everything private" withdraws their published pours with them.
    await db
      .update(schema.userProfiles)
      .set({ socialEnabled: false })
      .where(eq(schema.userProfiles.userId, leaving.id));
    expect(await stats()).toEqual({ avgRating: null, ratingCount: 0, raterCount: 0 });
  });

  it("suppresses an average that is really one or two people's rating", async () => {
    await publicRater(db, bottle.id, 5);
    expect((await stats()).avgRating).toBeNull();
    await publicRater(db, bottle.id, 3);
    expect((await stats()).avgRating).toBeNull();

    // Three distinct raters is where it becomes a community number.
    await publicRater(db, bottle.id, 4);
    expect(await stats()).toEqual({ avgRating: 4, ratingCount: 3, raterCount: 3 });
  });

  /**
   * Suppressing the average but reporting the counts moves the disclosure one
   * number over: this endpoint takes no session, so a count ticking 0 → 1 tells
   * a poller that a particular small group published a rating, and roughly when.
   */
  it("reports no counts either while it is below the floor", async () => {
    await publicRater(db, bottle.id, 5);
    expect(await stats()).toEqual({ avgRating: null, ratingCount: 0, raterCount: 0 });
    await publicRater(db, bottle.id, 3);
    expect(await stats()).toEqual({ avgRating: null, ratingCount: 0, raterCount: 0 });
  });

  it("counts people, not pours, so one enthusiast cannot clear the floor alone", async () => {
    const solo = await publicRater(db, bottle.id, 5);
    await db.insert(schema.pours).values([
      { id: uid("pour"), userId: solo.id, bottleId: bottle.id, rating: 5, visibility: "public" },
      { id: uid("pour"), userId: solo.id, bottleId: bottle.id, rating: 5, visibility: "public" },
    ]);
    // Three public rated pours, one person — below the floor, so nothing at all.
    expect(await stats()).toEqual({ avgRating: null, ratingCount: 0, raterCount: 0 });
  });

  it("reports nothing at all for a bottle nobody has published a rating for", async () => {
    expect(await stats()).toEqual({ avgRating: null, ratingCount: 0, raterCount: 0 });
  });
});

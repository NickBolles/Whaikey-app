import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    db = setupTestDb();
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

describe("GET /api/bottles/[id]", () => {
  beforeEach(() => {
    db = setupTestDb();
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
    // Ratings come from OTHER users' pours — community stats span all users.
    const alice = await createTestUser(db);
    const bob = await createTestUser(db);
    await db.insert(schema.pours).values([
      { id: uid("pour"), userId: alice.id, bottleId: bottle.id, rating: 4 },
      { id: uid("pour"), userId: bob.id, bottleId: bottle.id, rating: 5 },
      // Unrated pour must not drag the average or the rated count.
      { id: uid("pour"), userId: bob.id, bottleId: bottle.id, rating: null },
    ]);
    await db.insert(schema.pairings).values({
      id: uid("pairing"),
      bottleId: bottle.id,
      pairingType: "food",
      suggestion: "Dark chocolate",
      rationale: "Stands up to the proof.",
    });

    const res = await detailGET(searchRequest(""), detailCtx(bottle.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bottle).toMatchObject({ id: bottle.id, name: "Elijah Craig Barrel Proof" });
    expect(body.distillery).toMatchObject({ name: "Heaven Hill" });
    expect(body.communityStats).toEqual({ avgRating: 4.5, ratingCount: 2 });
    expect(body.userBottle).toBeNull();
    expect(body.pairings).toHaveLength(1);
    expect(body.pairings[0]).toMatchObject({ pairingType: "food", suggestion: "Dark chocolate" });
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

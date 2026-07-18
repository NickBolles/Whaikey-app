import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import {
  createTestBottle,
  createTestUser,
  jsonRequest,
  mockSessionModule,
  setSessionUser,
  setupTestDb,
  uid,
} from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { GET, POST } from "@/app/api/pours/route";
import { DELETE, GET as GET_ONE } from "@/app/api/pours/[id]/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/pours", () => {
  let db: DB;
  let user: schema.User;
  let bottle: schema.Bottle;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db);
    bottle = await createTestBottle(db, { name: "API Bourbon" });
    setSessionUser(user);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    const postRes = await POST(jsonRequest("/api/pours", "POST", { bottleId: bottle.id }));
    expect(postRes.status).toBe(401);
    const getRes = await GET(jsonRequest("/api/pours", "GET"));
    expect(getRes.status).toBe(401);
    const oneRes = await GET_ONE(jsonRequest("/api/pours/x", "GET"), ctx("x"));
    expect(oneRes.status).toBe(401);
  });

  it("POST creates a pour + note and returns 201 {pour, note}", async () => {
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: bottle.id,
      relationship: "own",
      status: "open",
      fillLevel: 100,
    });

    const res = await POST(
      jsonRequest("/api/pours", "POST", {
        bottleId: bottle.id,
        rating: 4.5,
        servingStyle: "neat",
        amountMl: 45,
        context: { setting: "porch" },
        note: { nose: "Vanilla bomb", flavorTags: { vanilla: 3, oak: 1 } },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.pour).toMatchObject({
      userId: user.id,
      bottleId: bottle.id,
      rating: 4.5,
      servingStyle: "neat",
      amountMl: 45,
      context: { setting: "porch" },
    });
    expect(body.pour.userBottleId).toBeTruthy();
    expect(body.note).toMatchObject({
      pourId: body.pour.id,
      nose: "Vanilla bomb",
      flavorTags: { vanilla: 3, oak: 1 },
      extractedBy: "user",
    });

    // fill decremented through the API path too
    const ub = await db.query.userBottles.findFirst({
      where: eq(schema.userBottles.userId, user.id),
    });
    expect(ub?.fillLevel).toBe(95);
  });

  it("POST rejects a non-half-step rating with 400", async () => {
    const res = await POST(jsonRequest("/api/pours", "POST", { bottleId: bottle.id, rating: 4.3 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body.details)).toMatch(/half-star/);
  });

  it("POST rejects an invalid flavor leaf with 400", async () => {
    const res = await POST(
      jsonRequest("/api/pours", "POST", {
        bottleId: bottle.id,
        note: { flavorTags: { "motor-oil": 2 } },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body.details)).toMatch(/Unknown flavor leaf/);
  });

  it("POST rejects intensity outside 1-3 with 400", async () => {
    const res = await POST(
      jsonRequest("/api/pours", "POST", { bottleId: bottle.id, note: { flavorTags: { vanilla: 0 } } }),
    );
    expect(res.status).toBe(400);
  });

  it("POST returns 404 for an unknown bottle", async () => {
    const res = await POST(jsonRequest("/api/pours", "POST", { bottleId: "ghost", rating: 4 }));
    expect(res.status).toBe(404);
  });

  it("GET lists only own pours, newest first, with bottle name + note", async () => {
    const other = await createTestUser(db);
    await db.insert(schema.pours).values({
      id: "theirs",
      userId: other.id,
      bottleId: bottle.id,
      rating: 5,
    });

    await POST(
      jsonRequest("/api/pours", "POST", {
        bottleId: bottle.id,
        rating: 4,
        note: { flavorTags: { cherry: 2 } },
      }),
    );

    const res = await GET(jsonRequest("/api/pours", "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pours).toHaveLength(1);
    expect(body.pours[0]).toMatchObject({
      userId: user.id,
      bottleName: "API Bourbon",
    });
    expect(body.pours[0].note.flavorTags).toEqual({ cherry: 2 });
  });

  it("GET filters by bottleId and honors limit", async () => {
    const otherBottle = await createTestBottle(db, { name: "Second Bottle", category: "rye" });
    await POST(jsonRequest("/api/pours", "POST", { bottleId: bottle.id, rating: 4 }));
    await POST(jsonRequest("/api/pours", "POST", { bottleId: otherBottle.id, rating: 3 }));
    await POST(jsonRequest("/api/pours", "POST", { bottleId: otherBottle.id, rating: 3.5 }));

    const filtered = await GET(jsonRequest(`/api/pours?bottleId=${otherBottle.id}`, "GET"));
    const filteredBody = await filtered.json();
    expect(filteredBody.pours).toHaveLength(2);
    for (const p of filteredBody.pours) expect(p.bottleId).toBe(otherBottle.id);

    const limited = await GET(jsonRequest("/api/pours?limit=1", "GET"));
    expect((await limited.json()).pours).toHaveLength(1);

    const bad = await GET(jsonRequest("/api/pours?limit=zero", "GET"));
    expect(bad.status).toBe(400);
  });

  it("GET /api/pours/[id] returns own pour with note, 404 for others'", async () => {
    const createRes = await POST(
      jsonRequest("/api/pours", "POST", { bottleId: bottle.id, rating: 4, note: { nose: "Oak" } }),
    );
    const { pour } = await createRes.json();

    const mine = await GET_ONE(jsonRequest(`/api/pours/${pour.id}`, "GET"), ctx(pour.id));
    expect(mine.status).toBe(200);
    const mineBody = await mine.json();
    expect(mineBody.pour.id).toBe(pour.id);
    expect(mineBody.note.nose).toBe("Oak");

    const other = await createTestUser(db);
    setSessionUser(other);
    const theirs = await GET_ONE(jsonRequest(`/api/pours/${pour.id}`, "GET"), ctx(pour.id));
    expect(theirs.status).toBe(404);
  });

  it("DELETE removes own pour + note, 404 for others' or missing", async () => {
    const createRes = await POST(
      jsonRequest("/api/pours", "POST", { bottleId: bottle.id, note: { nose: "Smoke" } }),
    );
    const { pour } = await createRes.json();

    const other = await createTestUser(db);
    setSessionUser(other);
    const denied = await DELETE(jsonRequest(`/api/pours/${pour.id}`, "DELETE"), ctx(pour.id));
    expect(denied.status).toBe(404);

    setSessionUser(user);
    const ok = await DELETE(jsonRequest(`/api/pours/${pour.id}`, "DELETE"), ctx(pour.id));
    expect(ok.status).toBe(200);
    expect(await db.query.pours.findMany()).toHaveLength(0);
    expect(await db.query.tastingNotes.findMany()).toHaveLength(0);

    const gone = await DELETE(jsonRequest(`/api/pours/${pour.id}`, "DELETE"), ctx(pour.id));
    expect(gone.status).toBe(404);
  });
});

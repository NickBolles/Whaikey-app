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
import { GET, POST } from "./route";
import { DELETE, PATCH } from "./[id]/route";

vi.mock("@/lib/session", async () => mockSessionModule());

function idCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("/api/user-bottles", () => {
  let db: DB;
  let user: schema.User;
  let bottle: schema.Bottle;

  beforeEach(async () => {
    db = setupTestDb();
    user = await createTestUser(db);
    bottle = await createTestBottle(db);
    setSessionUser(user);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    const getRes = await GET(jsonRequest("/api/user-bottles", "GET"));
    expect(getRes.status).toBe(401);
    const postRes = await POST(
      jsonRequest("/api/user-bottles", "POST", { bottleId: bottle.id, relationship: "own" }),
    );
    expect(postRes.status).toBe(401);
    const patchRes = await PATCH(
      jsonRequest("/api/user-bottles/x", "PATCH", { fillLevel: 50 }),
      idCtx("x"),
    );
    expect(patchRes.status).toBe(401);
  });

  it("POST inserts an own row with defaults sealed/100/qty1 (201)", async () => {
    const res = await POST(
      jsonRequest("/api/user-bottles", "POST", { bottleId: bottle.id, relationship: "own" }),
    );
    expect(res.status).toBe(201);
    const row = await res.json();
    expect(row).toMatchObject({
      userId: user.id,
      bottleId: bottle.id,
      relationship: "own",
      status: "sealed",
      fillLevel: 100,
      quantity: 1,
    });
  });

  it("POST does not apply own-defaults to wishlist rows", async () => {
    const res = await POST(
      jsonRequest("/api/user-bottles", "POST", { bottleId: bottle.id, relationship: "wishlist" }),
    );
    expect(res.status).toBe(201);
    const row = await res.json();
    expect(row.status).toBeNull();
    expect(row.fillLevel).toBeNull();
  });

  it("POST upserts by (userId, bottleId) without creating a duplicate (200)", async () => {
    const first = await POST(
      jsonRequest("/api/user-bottles", "POST", { bottleId: bottle.id, relationship: "wishlist" }),
    );
    expect(first.status).toBe(201);
    const created = await first.json();

    const second = await POST(
      jsonRequest("/api/user-bottles", "POST", {
        bottleId: bottle.id,
        relationship: "own",
        purchasePrice: 42.5,
        purchaseDate: "2026-07-01T00:00:00.000Z",
        store: "Total Wine",
      }),
    );
    expect(second.status).toBe(200);
    const updated = await second.json();
    expect(updated.id).toBe(created.id);
    expect(updated.relationship).toBe("own");
    expect(updated.purchasePrice).toBe(42.5);
    expect(updated.store).toBe("Total Wine");

    const rows = await db
      .select()
      .from(schema.userBottles)
      .where(eq(schema.userBottles.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it("POST rejects an invalid relationship (400)", async () => {
    const res = await POST(
      jsonRequest("/api/user-bottles", "POST", { bottleId: bottle.id, relationship: "borrowed" }),
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects an out-of-range fillLevel (400)", async () => {
    const res = await POST(
      jsonRequest("/api/user-bottles", "POST", {
        bottleId: bottle.id,
        relationship: "own",
        fillLevel: 150,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST returns 404 for an unknown bottleId", async () => {
    const res = await POST(
      jsonRequest("/api/user-bottles", "POST", { bottleId: "nope", relationship: "own" }),
    );
    expect(res.status).toBe(404);
  });

  it("GET filters by relationship and joins bottle fields, newest first", async () => {
    const [dist] = await db
      .insert(schema.distilleries)
      .values({ id: uid("dist"), name: "Heaven Hill", country: "USA" })
      .returning();
    const bottleWithDist = await createTestBottle(db, {
      name: "Elijah Craig",
      distilleryId: dist.id,
      avgPrice: 32,
      flavorProfile: { sweet: 8, woody: 6 },
    });
    const older = new Date(Date.now() - 60_000);
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: bottle.id,
      relationship: "own",
      status: "open",
      updatedAt: older,
    });
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: bottleWithDist.id,
      relationship: "own",
      status: "sealed",
      updatedAt: new Date(),
    });
    const wishBottle = await createTestBottle(db);
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: wishBottle.id,
      relationship: "wishlist",
    });

    const res = await GET(jsonRequest("/api/user-bottles?relationship=own", "GET"));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(2);
    expect(rows[0].bottle).toMatchObject({
      name: "Elijah Craig",
      category: "bourbon",
      distilleryName: "Heaven Hill",
      avgPrice: 32,
      flavorProfile: { sweet: 8, woody: 6 },
    });
    expect(rows[1].bottle.distilleryName).toBeNull();
    expect(rows.every((r: { relationship: string }) => r.relationship === "own")).toBe(true);
  });

  it("GET rejects an invalid relationship filter (400)", async () => {
    const res = await GET(jsonRequest("/api/user-bottles?relationship=hoarded", "GET"));
    expect(res.status).toBe(400);
  });

  it("PATCH returns 404 for another user's row", async () => {
    const other = await createTestUser(db);
    const [theirs] = await db
      .insert(schema.userBottles)
      .values({ id: uid("ub"), userId: other.id, bottleId: bottle.id, relationship: "own" })
      .returning();

    const res = await PATCH(
      jsonRequest(`/api/user-bottles/${theirs.id}`, "PATCH", { fillLevel: 10 }),
      idCtx(theirs.id),
    );
    expect(res.status).toBe(404);
  });

  it("PATCH status finished forces fillLevel 0 even with an explicit level", async () => {
    const [mine] = await db
      .insert(schema.userBottles)
      .values({
        id: uid("ub"),
        userId: user.id,
        bottleId: bottle.id,
        relationship: "own",
        status: "open",
        fillLevel: 40,
      })
      .returning();

    const res = await PATCH(
      jsonRequest(`/api/user-bottles/${mine.id}`, "PATCH", { status: "finished", fillLevel: 55 }),
      idCtx(mine.id),
    );
    expect(res.status).toBe(200);
    const row = await res.json();
    expect(row.status).toBe("finished");
    expect(row.fillLevel).toBe(0);
  });

  it("PATCH status open defaults fillLevel to 100 when previously sealed", async () => {
    const [mine] = await db
      .insert(schema.userBottles)
      .values({
        id: uid("ub"),
        userId: user.id,
        bottleId: bottle.id,
        relationship: "own",
        status: "sealed",
        fillLevel: null,
      })
      .returning();

    const res = await PATCH(
      jsonRequest(`/api/user-bottles/${mine.id}`, "PATCH", { status: "open" }),
      idCtx(mine.id),
    );
    expect(res.status).toBe(200);
    const row = await res.json();
    expect(row.status).toBe("open");
    expect(row.fillLevel).toBe(100);
  });

  it("PATCH status open keeps an explicitly provided fillLevel", async () => {
    const [mine] = await db
      .insert(schema.userBottles)
      .values({
        id: uid("ub"),
        userId: user.id,
        bottleId: bottle.id,
        relationship: "own",
        status: "sealed",
      })
      .returning();

    const res = await PATCH(
      jsonRequest(`/api/user-bottles/${mine.id}`, "PATCH", { status: "open", fillLevel: 60 }),
      idCtx(mine.id),
    );
    const row = await res.json();
    expect(row.fillLevel).toBe(60);
  });

  it("DELETE removes the row and 404s for non-owners", async () => {
    const [mine] = await db
      .insert(schema.userBottles)
      .values({ id: uid("ub"), userId: user.id, bottleId: bottle.id, relationship: "own" })
      .returning();

    const other = await createTestUser(db);
    const otherBottle = await createTestBottle(db);
    const [theirs] = await db
      .insert(schema.userBottles)
      .values({ id: uid("ub"), userId: other.id, bottleId: otherBottle.id, relationship: "own" })
      .returning();

    const denied = await DELETE(
      jsonRequest(`/api/user-bottles/${theirs.id}`, "DELETE"),
      idCtx(theirs.id),
    );
    expect(denied.status).toBe(404);

    const ok = await DELETE(jsonRequest(`/api/user-bottles/${mine.id}`, "DELETE"), idCtx(mine.id));
    expect(ok.status).toBe(200);

    const remaining = await db
      .select()
      .from(schema.userBottles)
      .where(eq(schema.userBottles.userId, user.id));
    expect(remaining).toHaveLength(0);
  });
});

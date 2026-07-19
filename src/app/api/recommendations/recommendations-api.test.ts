import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { setAnthropicForTests } from "@/lib/ai/client";

vi.mock("@/lib/session", async () => mockSessionModule());

let db: DB;
let user: schema.User;

beforeEach(async () => {
  db = await setupTestDb();
  setAnthropicForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
  user = await createTestUser(db);
  setSessionUser(user);
});

async function seedPalateAndBottles(): Promise<void> {
  const drunk = await createTestBottle(db, { flavorProfile: { peaty: 9, woody: 6 } });
  await db.insert(schema.pours).values({ id: uid("pour"), userId: user.id, bottleId: drunk.id, rating: 5 });

  const discovery = await createTestBottle(db, {
    name: "Discovery Smoky",
    flavorProfile: { peaty: 9, woody: 5 },
    avgPrice: 60,
  });
  const open = await createTestBottle(db, { name: "Open Bottle", flavorProfile: { peaty: 8, woody: 5 } });
  await db.insert(schema.userBottles).values({
    id: uid("ub"),
    userId: user.id,
    bottleId: open.id,
    relationship: "own",
    status: "open",
    fillLevel: 30,
  });
  void discovery;
}

describe("GET /api/recommendations", () => {
  it("401s when signed out", async () => {
    setSessionUser(null);
    const { GET } = await import("./route");
    const res = await GET(jsonRequest("/api/recommendations", "GET"));
    expect(res.status).toBe(401);
  });

  it("returns discovery recommendations for a user with a palate", async () => {
    await seedPalateAndBottles();
    const { GET } = await import("./route");
    const res = await GET(jsonRequest("/api/recommendations?mode=discovery", "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("discovery");
    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(body.recommendations.length).toBeGreaterThan(0);
    expect(body.recommendations[0].reason.length).toBeGreaterThan(0);
  });

  it("returns tonight recommendations from the user's open bottles", async () => {
    await seedPalateAndBottles();
    const { GET } = await import("./route");
    const res = await GET(jsonRequest("/api/recommendations?mode=tonight", "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("tonight");
    expect(body.recommendations.length).toBeGreaterThan(0);
    expect(body.recommendations[0].status).toBe("open");
  });

  it("defaults to discovery mode", async () => {
    await seedPalateAndBottles();
    const { GET } = await import("./route");
    const res = await GET(jsonRequest("/api/recommendations", "GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("discovery");
  });

  it("400s on an invalid mode", async () => {
    const { GET } = await import("./route");
    const res = await GET(jsonRequest("/api/recommendations?mode=nonsense", "GET"));
    expect(res.status).toBe(400);
  });

  it("400s on an invalid limit", async () => {
    const { GET } = await import("./route");
    const res = await GET(jsonRequest("/api/recommendations?limit=0", "GET"));
    expect(res.status).toBe(400);
  });
});

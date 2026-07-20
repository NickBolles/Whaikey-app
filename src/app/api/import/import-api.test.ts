import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type * as schema from "@/db/schema";
import { type DB, schema as dbSchema } from "@/db";
import {
  createTestBottle,
  createTestUser,
  jsonRequest,
  mockSessionModule,
  setSessionUser,
  setupTestDb,
} from "@/test/helpers";
import { setAnthropicForTests } from "@/lib/ai/client";
import { makeFakeAnthropic, textResponse } from "@/lib/ai/testing";
import { confirmUpcMapping, resolveUpc } from "@/lib/scan";
import { POST as analyzePost } from "./analyze/route";
import { POST as matchPost } from "./match/route";
import { POST as commitPost } from "./commit/route";

vi.mock("@/lib/session", async () => mockSessionModule());

const UPC = "080244002145"; // valid check digit

let db: DB;
let user: schema.User;

beforeEach(async () => {
  db = await setupTestDb();
  user = await createTestUser(db);
  setSessionUser(null);
  setAnthropicForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
});

describe("POST /api/import/analyze", () => {
  it("returns 401 when signed out", async () => {
    const res = await analyzePost(
      jsonRequest("/api/import/analyze", "POST", { headers: ["Name"], sampleRows: [] }),
    );
    expect(res.status).toBe(401);
  });

  it("falls back to heuristics when AI is not configured", async () => {
    setSessionUser(user);
    const res = await analyzePost(
      jsonRequest("/api/import/analyze", "POST", {
        headers: ["Bottle", "UPC", "Price Paid"],
        sampleRows: [["Eagle Rare", UPC, "39.99"]],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("heuristic");
    expect(body.mapping).toMatchObject({ name: 0, upc: 1, purchasePrice: 2 });
  });

  it("uses the AI mapping when configured, validated against real headers", async () => {
    setSessionUser(user);
    const fake = makeFakeAnthropic([
      textResponse(
        JSON.stringify({
          name: "Whisky",
          upc: "Code",
          purchasePrice: "What I paid",
          purchaseDate: null,
          store: "Bought at",
          relationship: null,
          status: null,
          fillLevel: null,
          quantity: null,
          location: null,
          notes: "Not-a-real-header",
        }),
      ),
    ]);
    setAnthropicForTests(fake.client);

    const res = await analyzePost(
      jsonRequest("/api/import/analyze", "POST", {
        headers: ["Whisky", "Code", "What I paid", "Bought at"],
        sampleRows: [["Stagg", UPC, "99", "K&L"]],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("ai");
    expect(body.mapping).toMatchObject({ name: 0, upc: 1, purchasePrice: 2, store: 3 });
    // Hallucinated header names are dropped, not trusted.
    expect(body.mapping.notes).toBeNull();
  });

  it("degrades to heuristics when the model errors", async () => {
    setSessionUser(user);
    const fake = makeFakeAnthropic([]); // queue empty → create() throws
    setAnthropicForTests(fake.client);
    const res = await analyzePost(
      jsonRequest("/api/import/analyze", "POST", {
        headers: ["Bottle"],
        sampleRows: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("heuristic");
    expect(body.mapping.name).toBe(0);
  });
});

describe("POST /api/import/match", () => {
  it("returns 401 when signed out", async () => {
    const res = await matchPost(jsonRequest("/api/import/match", "POST", { rows: [{ name: "x" }] }));
    expect(res.status).toBe(401);
  });

  it("matches by UPC first, then by fuzzy name, else empty", async () => {
    setSessionUser(user);
    const eagle = await createTestBottle(db, { name: "Eagle Rare 10 Year" });
    const stagg = await createTestBottle(db, { name: "Stagg" });
    await confirmUpcMapping(db, UPC, eagle.id);

    const res = await matchPost(
      jsonRequest("/api/import/match", "POST", {
        rows: [
          { name: "completely wrong name", upc: UPC },
          { name: "stag" },
          { name: "zzz unknown zzz" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(3);
    expect(body.results[0].candidates[0]).toMatchObject({ id: eagle.id, via: "upc" });
    expect(body.results[1].candidates[0]).toMatchObject({ id: stagg.id, via: "name" });
    expect(body.results[2].candidates).toEqual([]);
  });

  it("rejects oversized batches", async () => {
    setSessionUser(user);
    const rows = Array.from({ length: 301 }, () => ({ name: "x" }));
    const res = await matchPost(jsonRequest("/api/import/match", "POST", { rows }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/import/commit", () => {
  it("returns 401 when signed out", async () => {
    const res = await commitPost(
      jsonRequest("/api/import/commit", "POST", {
        items: [{ bottleId: "x", relationship: "own" }],
      }),
    );
    expect(res.status).toBe(401);
  });

  it("bulk-upserts shelf rows, teaches UPCs, and skips unknown bottles", async () => {
    setSessionUser(user);
    const eagle = await createTestBottle(db, { name: "Eagle Rare 10 Year" });
    const stagg = await createTestBottle(db, { name: "Stagg" });

    const res = await commitPost(
      jsonRequest("/api/import/commit", "POST", {
        items: [
          {
            bottleId: eagle.id,
            relationship: "own",
            purchasePrice: 39.99,
            purchaseDate: "2026-03-12T00:00:00.000Z",
            store: "Total Wine",
            upc: UPC,
          },
          { bottleId: stagg.id, relationship: "wishlist" },
          { bottleId: "not-a-bottle", relationship: "own" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ added: 2, updated: 0, upcsTaught: 1, skipped: 1 });

    const row = await db.query.userBottles.findFirst({
      where: and(
        eq(dbSchema.userBottles.userId, user.id),
        eq(dbSchema.userBottles.bottleId, eagle.id),
      ),
    });
    expect(row).toMatchObject({ purchasePrice: 39.99, store: "Total Wine", status: "sealed" });

    const matches = await resolveUpc(db, UPC);
    expect(matches.map((m) => m.id)).toEqual([eagle.id]);
  });

  it("re-importing updates instead of duplicating", async () => {
    setSessionUser(user);
    const eagle = await createTestBottle(db);
    const payload = {
      items: [{ bottleId: eagle.id, relationship: "own", purchasePrice: 10 }],
    };
    await commitPost(jsonRequest("/api/import/commit", "POST", payload));
    const res = await commitPost(
      jsonRequest("/api/import/commit", "POST", {
        items: [{ bottleId: eagle.id, relationship: "own", purchasePrice: 12 }],
      }),
    );
    const body = await res.json();
    expect(body).toMatchObject({ added: 0, updated: 1 });

    const rows = await db
      .select()
      .from(dbSchema.userBottles)
      .where(eq(dbSchema.userBottles.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].purchasePrice).toBe(12);
  });
});

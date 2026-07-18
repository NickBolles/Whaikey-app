import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, setupTestDb, uid } from "@/test/helpers";
import { getOrGeneratePairings } from "./pairings";
import { setAnthropicForTests } from "./client";
import { makeFakeAnthropic, textResponse } from "./testing";

let db: DB;

beforeEach(() => {
  db = setupTestDb();
  setAnthropicForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
});

const GENERATED = JSON.stringify([
  { pairingType: "food", suggestion: "Dark chocolate", rationale: "Echoes the sweet, woody profile" },
  { pairingType: "food", suggestion: "Smoked brisket", rationale: "Char matches the oak" },
  { pairingType: "food", suggestion: "Aged cheddar", rationale: "Cuts the spice" },
  { pairingType: "cocktail", suggestion: "Old Fashioned", rationale: "Sweet profile suits stirring" },
  { pairingType: "spaceship", suggestion: "Nope", rationale: "invalid type is dropped" },
]);

describe("getOrGeneratePairings", () => {
  it("returns null for an unknown bottle", async () => {
    expect(await getOrGeneratePairings(db, "missing")).toBeNull();
  });

  it("generates once, caches with source ai, and serves the cache on later calls", async () => {
    const bottle = await createTestBottle(db);
    const fake = makeFakeAnthropic([textResponse(GENERATED)]);

    const first = await getOrGeneratePairings(db, bottle.id, fake.client);
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(4); // invalid pairingType dropped
    expect(first?.every((p) => p.source === "ai")).toBe(true);
    expect(first?.map((p) => p.pairingType)).toEqual(["food", "food", "food", "cocktail"]);

    // Second call hits the cache — create is NOT called again.
    const second = await getOrGeneratePairings(db, bottle.id, fake.client);
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(4);

    const rows = await db
      .select()
      .from(schema.pairings)
      .where(eq(schema.pairings.bottleId, bottle.id));
    expect(rows).toHaveLength(4);
  });

  it("returns existing cached rows without calling the model", async () => {
    const bottle = await createTestBottle(db);
    await db.insert(schema.pairings).values({
      id: uid("pair"),
      bottleId: bottle.id,
      pairingType: "food",
      suggestion: "Pecan pie",
      rationale: "Sweet on sweet",
      source: "community",
    });
    const fake = makeFakeAnthropic([]);
    const result = await getOrGeneratePairings(db, bottle.id, fake.client);
    expect(result).toHaveLength(1);
    expect(result?.[0].suggestion).toBe("Pecan pie");
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("returns [] when the cache is empty and AI is not configured", async () => {
    const bottle = await createTestBottle(db);
    const result = await getOrGeneratePairings(db, bottle.id);
    expect(result).toEqual([]);
  });

  it("returns [] when the model output is unusable and caches nothing", async () => {
    const bottle = await createTestBottle(db);
    const fake = makeFakeAnthropic([textResponse("no json here")]);
    const result = await getOrGeneratePairings(db, bottle.id, fake.client);
    expect(result).toEqual([]);
    const rows = await db
      .select()
      .from(schema.pairings)
      .where(eq(schema.pairings.bottleId, bottle.id));
    expect(rows).toHaveLength(0);
  });
});

describe("GET /api/bottles/[id]/pairings", () => {
  it("404s for an unknown bottle and 200s with cached pairings", async () => {
    const { GET } = await import("@/app/api/bottles/[id]/pairings/route");

    const missing = await GET(new Request("http://localhost:3000/api/bottles/x/pairings"), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(missing.status).toBe(404);

    const bottle = await createTestBottle(db);
    await db.insert(schema.pairings).values({
      id: uid("pair"),
      bottleId: bottle.id,
      pairingType: "food",
      suggestion: "Grilled peaches",
      rationale: "Fruit meets caramel",
      source: "ai",
    });
    const ok = await GET(
      new Request(`http://localhost:3000/api/bottles/${bottle.id}/pairings`),
      { params: Promise.resolve({ id: bottle.id }) },
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.pairings).toHaveLength(1);
    expect(body.pairings[0].suggestion).toBe("Grilled peaches");
  });
});

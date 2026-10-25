import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { confirmUpcMapping } from "@/lib/scan";
import { POST as resolvePost } from "./upc/route";
import { POST as confirmPost } from "./confirm/route";

vi.mock("@/lib/session", async () => mockSessionModule());

const UPC = "080244002145"; // valid check digit

let db: DB;
let user: schema.User;

beforeEach(async () => {
  db = await setupTestDb();
  user = await createTestUser(db);
  setSessionUser(null);
  process.env.WHAIKEY_UPC_LOOKUP = "off";
});

afterEach(() => {
  delete process.env.WHAIKEY_UPC_LOOKUP;
  vi.unstubAllGlobals();
});

describe("POST /api/scan/upc", () => {
  it("returns 401 when signed out", async () => {
    const res = await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: UPC }));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body", async () => {
    setSessionUser(user);
    const res = await resolvePost(jsonRequest("/api/scan/upc", "POST", {}));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid barcode with a clear error", async () => {
    setSessionUser(user);
    const res = await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: "080244002144" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid UPC/i);
  });

  it("resolves a confirmed mapping from our own DB", async () => {
    setSessionUser(user);
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10 Year" });
    await confirmUpcMapping(db, UPC, bottle.id);

    const res = await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: UPC }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upc).toBe(UPC);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].id).toBe(bottle.id);
    expect(body.candidates).toEqual([]);
  });

  it("normalizes scanner formats (EAN-13 zero padding, separators)", async () => {
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    await confirmUpcMapping(db, UPC, bottle.id);

    const res = await resolvePost(
      jsonRequest("/api/scan/upc", "POST", { upc: "0-080244-002145" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upc).toBe(UPC);
    expect(body.matches).toHaveLength(1);
  });

  it("returns empty matches on a miss with external lookup disabled", async () => {
    setSessionUser(user);
    const res = await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: UPC }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toEqual([]);
    expect(body.candidates).toEqual([]);
    expect(body.externalName).toBeNull();
  });

  it("falls back to an external lookup and offers catalog candidates", async () => {
    setSessionUser(user);
    delete process.env.WHAIKEY_UPC_LOOKUP;
    const bottle = await createTestBottle(db, { name: "Buffalo Trace" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ items: [{ title: "Buffalo Trace Kentucky Straight Bourbon 750ml" }] }),
      ),
    );

    const res = await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: UPC }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toEqual([]);
    expect(body.externalName).toBe("Buffalo Trace Kentucky Straight Bourbon 750ml");
    expect(body.candidates.map((c: { id: string }) => c.id)).toContain(bottle.id);
  });

  it("degrades to a plain miss when the external lookup fails", async () => {
    setSessionUser(user);
    delete process.env.WHAIKEY_UPC_LOOKUP;
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));

    const res = await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: UPC }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches).toEqual([]);
    expect(body.candidates).toEqual([]);
    expect(body.externalName).toBeNull();
  });
});

describe("POST /api/scan/confirm", () => {
  it("returns 401 when signed out", async () => {
    const res = await confirmPost(
      jsonRequest("/api/scan/confirm", "POST", { upc: UPC, bottleId: "x" }),
    );
    expect(res.status).toBe(401);
  });

  it("404s for an unknown bottle", async () => {
    setSessionUser(user);
    const res = await confirmPost(
      jsonRequest("/api/scan/confirm", "POST", { upc: UPC, bottleId: "nope" }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects an invalid barcode", async () => {
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    const res = await confirmPost(
      jsonRequest("/api/scan/confirm", "POST", { upc: "not-a-code", bottleId: bottle.id }),
    );
    expect(res.status).toBe(400);
  });

  it("records the mapping and adds to the bar in one call", async () => {
    setSessionUser(user);
    const bottle = await createTestBottle(db);

    const res = await confirmPost(
      jsonRequest("/api/scan/confirm", "POST", {
        upc: UPC,
        bottleId: bottle.id,
        relationship: "own",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mapping.upc).toBe(UPC);
    expect(body.mapping.confirmedCount).toBe(1);
    expect(body.userBottle.relationship).toBe("own");
    expect(body.userBottle.status).toBe("sealed");
    expect(body.userBottle.fillLevel).toBe(100);
    expect(body.bottle.name).toBe(bottle.name);

    const row = await db.query.userBottles.findFirst({
      where: and(
        eq(dbSchema.userBottles.userId, user.id),
        eq(dbSchema.userBottles.bottleId, bottle.id),
      ),
    });
    expect(row).toBeTruthy();
  });

  it("strengthens an existing mapping (200, not a duplicate)", async () => {
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    await confirmUpcMapping(db, UPC, bottle.id);

    const res = await confirmPost(
      jsonRequest("/api/scan/confirm", "POST", { upc: UPC, bottleId: bottle.id }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mapping.confirmedCount).toBe(2);
    expect(body.userBottle).toBeNull();
  });

  it("works without a upc (label-photo confirmations)", async () => {
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    const res = await confirmPost(
      jsonRequest("/api/scan/confirm", "POST", { bottleId: bottle.id, relationship: "tried" }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mapping).toBeNull();
    expect(body.userBottle.relationship).toBe("tried");
  });
});

describe("scan telemetry (M0.5)", () => {
  const events = () => db.select().from(dbSchema.scanEvents);

  it("records an own-DB hit without storing the barcode", async () => {
    setSessionUser(user);
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10 Year" });
    await confirmUpcMapping(db, UPC, bottle.id);
    await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: UPC }));
    const [e] = await events();
    expect(e).toMatchObject({ kind: "barcode", outcome: "matched", source: "own", resultCount: 1, upc: null });
    expect(e.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records a miss with the unmapped barcode, and no user anywhere on the row", async () => {
    setSessionUser(user);
    await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: UPC }));
    const [e] = await events();
    expect(e).toMatchObject({ kind: "barcode", outcome: "miss", source: "none", upc: UPC, resultCount: 0 });
    expect(Object.keys(e)).not.toContain("userId");
    expect(JSON.stringify(e)).not.toContain(user.id);
  });

  it("attributes provider candidates to the provider", async () => {
    setSessionUser(user);
    delete process.env.WHAIKEY_UPC_LOOKUP;
    await createTestBottle(db, { name: "Buffalo Trace" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [{ title: "Buffalo Trace Bourbon 750ml" }] })));
    await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: UPC }));
    const [e] = await events();
    expect(e).toMatchObject({ outcome: "candidates", source: "upcitemdb", upc: UPC });
    expect(e.resultCount).toBeGreaterThan(0);
  });

  it("does not record an invalid barcode or a signed-out request", async () => {
    await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: UPC }));
    setSessionUser(user);
    await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: "080244002144" }));
    expect(await events()).toHaveLength(0);
  });

  it("records the confirmed bottle's rank among our own matches, read before the confirmation", async () => {
    setSessionUser(user);
    const top = await createTestBottle(db, { name: "Eagle Rare 10 Year" });
    const other = await createTestBottle(db, { name: "Eagle Rare 17 Year" });
    const unrelated = await createTestBottle(db, { name: "Blanton's Original" });
    await confirmUpcMapping(db, UPC, top.id);
    await confirmUpcMapping(db, UPC, top.id);
    await confirmUpcMapping(db, UPC, other.id);

    for (const b of [top, other, unrelated]) {
      await confirmPost(jsonRequest("/api/scan/confirm", "POST", { upc: UPC, bottleId: b.id }));
    }
    const ranks = (await events()).filter((e) => e.outcome === "confirmed").map((e) => [e.source, e.confirmRank]);
    expect(ranks).toEqual([
      ["own", 0],
      ["own", 1],
      ["none", null],
    ]);
  });

  it("records a barcode-less confirmation as a label/search pick", async () => {
    setSessionUser(user);
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10 Year" });
    await confirmPost(jsonRequest("/api/scan/confirm", "POST", { bottleId: bottle.id }));
    const [e] = await events();
    expect(e).toMatchObject({ kind: "label", outcome: "confirmed", confirmRank: null, upc: null });
  });

  it("never fails the scan when the telemetry write fails", async () => {
    setSessionUser(user);
    const realInsert = db.insert.bind(db);
    db.insert = ((t: unknown) =>
      t === dbSchema.scanEvents
        ? { values: () => Promise.reject(new Error("telemetry down")) }
        : realInsert(t as never)) as unknown as typeof db.insert;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await resolvePost(jsonRequest("/api/scan/upc", "POST", { upc: UPC }));
      expect(res.status).toBe(200);
    } finally {
      db.insert = realInsert;
      spy.mockRestore();
    }
  });
});

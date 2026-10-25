import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { POST as labelTextPost } from "./label-text/route";
import { POST as claimsPost } from "./claims/route";
import { POST as confirmPost } from "./confirm/route";

vi.mock("@/lib/session", async () => mockSessionModule());

let db: DB;
let user: schema.User;
beforeEach(async () => {
  db = await setupTestDb();
  user = await createTestUser(db);
  setSessionUser(null);
});

const lines = (...text: string[]) => text.map((t) => ({ text: t }));

describe("POST /api/scan/label-text", () => {
  it("401 signed out, 400 on a bad body", async () => {
    expect((await labelTextPost(jsonRequest("/api/scan/label-text", "POST", { lines: lines("X") }))).status).toBe(401);
    setSessionUser(user);
    expect((await labelTextPost(jsonRequest("/api/scan/label-text", "POST", { lines: [] }))).status).toBe(400);
    expect(
      (await labelTextPost(jsonRequest("/api/scan/label-text", "POST", { lines: [{ text: "x".repeat(301) }] }))).status,
    ).toBe(400);
  });

  it("a clear label resolves on-device with no AI call, recorded as an OCR answer", async () => {
    setSessionUser(user);
    const lag16 = await createTestBottle(db, { name: "Lagavulin 16 Year Old", ageYears: 16, abv: 43, category: "scotch-single-malt" });
    await createTestBottle(db, { name: "Lagavulin 8 Year Old", ageYears: 8, abv: 48, category: "scotch-single-malt" });
    const res = await labelTextPost(
      jsonRequest("/api/scan/label-text", "POST", {
        engine: "vision",
        lines: [
          { text: "LAGAVULIN", height: 0.12 },
          { text: "ISLAY SINGLE MALT SCOTCH WHISKY", height: 0.03 },
          { text: "aged 16 years", height: 0.05 },
          { text: "43% vol", height: 0.02 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.confident).toBe(true);
    expect(body.candidates[0].id).toBe(lag16.id);
    expect(body.signals).toEqual({ ageYears: 16, abv: 43 });
    const [e] = await db.select().from(dbSchema.scanEvents);
    expect(e).toMatchObject({ kind: "label", outcome: "candidates", source: "ocr", upc: null });
  });

  it("an unclear read is deferred to the AI and counted as such", async () => {
    setSessionUser(user);
    await createTestBottle(db, { name: "Lagavulin 16 Year Old", ageYears: 16 });
    const body = await (
      await labelTextPost(jsonRequest("/api/scan/label-text", "POST", { lines: lines("GOVERNMENT WARNING", "750 ML") }))
    ).json();
    expect(body.confident).toBe(false);
    const [e] = await db.select().from(dbSchema.scanEvents);
    expect(e).toMatchObject({ kind: "label", outcome: "deferred", source: "ocr" });
  });

  it("never offers someone else's pending submission", async () => {
    const other = await createTestUser(db);
    await createTestBottle(db, { name: "Secret Barrel Lagavulin 16", ageYears: 16, status: "user_submitted", submittedBy: other.id });
    setSessionUser(user);
    const body = await (
      await labelTextPost(jsonRequest("/api/scan/label-text", "POST", { lines: lines("SECRET BARREL", "LAGAVULIN", "16 YEARS") }))
    ).json();
    expect(body.candidates).toEqual([]);
  });

  it("a confirm after an OCR read is attributed to OCR", async () => {
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    await confirmPost(jsonRequest("/api/scan/confirm", "POST", { bottleId: bottle.id, via: "ocr" }));
    const [e] = await db.select().from(dbSchema.scanEvents);
    expect(e).toMatchObject({ kind: "label", outcome: "confirmed", source: "ocr" });
  });
});

describe("POST /api/scan/claims (operator)", () => {
  const UPC = "080244002145";

  it("404s for non-operators, signed in or not", async () => {
    expect((await claimsPost(jsonRequest("/api/scan/claims", "POST", { action: "approve", upc: UPC, bottleId: "b" }))).status).toBe(404);
    setSessionUser(user);
    expect((await claimsPost(jsonRequest("/api/scan/claims", "POST", { action: "approve", upc: UPC, bottleId: "b" }))).status).toBe(404);
  });

  it("approves and rejects pending claims", async () => {
    vi.stubEnv("WHAIKEY_OPERATOR_IDS", "op-claims");
    try {
      const op = await createTestUser(db, { id: "op-claims" });
      const bottle = await createTestBottle(db);
      setSessionUser(user);
      await confirmPost(jsonRequest("/api/scan/confirm", "POST", { upc: UPC, bottleId: bottle.id }));
      setSessionUser(op);
      expect((await claimsPost(jsonRequest("/api/scan/claims", "POST", { action: "approve", upc: "bad", bottleId: bottle.id }))).status).toBe(400);
      const ok = await claimsPost(jsonRequest("/api/scan/claims", "POST", { action: "approve", upc: UPC, bottleId: bottle.id }));
      expect(ok.status).toBe(200);
      expect(await db.select().from(dbSchema.bottleUpcs)).toHaveLength(1);
      const rej = await claimsPost(jsonRequest("/api/scan/claims", "POST", { action: "reject", upc: UPC, bottleId: bottle.id }));
      expect(rej.status).toBe(200);
      expect(await db.select().from(dbSchema.bottleUpcs)).toHaveLength(0);
      expect((await claimsPost(jsonRequest("/api/scan/claims", "POST", { action: "approve", upc: UPC, bottleId: bottle.id }))).status).toBe(404);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

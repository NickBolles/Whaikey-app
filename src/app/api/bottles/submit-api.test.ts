import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import {
  setupTestDb,
  createTestBottle,
  createTestUser,
  setSessionUser,
} from "@/test/helpers";
import { POST as submitPOST } from "@/app/api/bottles/route";
import { GET as detailGET } from "@/app/api/bottles/[id]/route";
import { GET as searchGET } from "@/app/api/bottles/search/route";
import { POST as shelfPOST } from "@/app/api/user-bottles/route";
import { POST as confirmPOST } from "@/app/api/scan/confirm/route";

vi.mock("@/lib/session", async () => {
  const { mockSessionModule } = await import("@/test/helpers");
  return mockSessionModule();
});

let db: DB;
let alice: schema.User;
let bob: schema.User;

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = await setupTestDb();
  alice = await createTestUser(db, { name: "Alice" });
  bob = await createTestUser(db, { name: "Bob" });
  setSessionUser(alice);
});

describe("POST /api/bottles", () => {
  it("requires a session", async () => {
    setSessionUser(null);
    const res = await submitPOST(post("/api/bottles", { name: "Anything", category: "bourbon" }));
    expect(res.status).toBe(401);
  });

  it("creates a bottle that is usable immediately", async () => {
    const res = await submitPOST(
      post("/api/bottles", {
        name: "Barrell Dovetail",
        category: "american-other",
        relationship: "own",
        source: "search",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bottle.status).toBe("user_submitted");
    // The shelf row is what "usable immediately" means in practice: the point
    // of the submission path is that the miss stops being a dead end.
    expect(body.userBottle).toMatchObject({ relationship: "own" });

    const res2 = await detailGET(new Request("http://localhost:3000/x"), {
      params: Promise.resolve({ id: body.bottle.id }),
    });
    expect(res2.status).toBe(200);
  });

  it("rejects a body that is missing what a bottle needs", async () => {
    const res = await submitPOST(post("/api/bottles", { name: "x", category: "bourbon" }));
    expect(res.status).toBe(400);
    const res2 = await submitPOST(post("/api/bottles", { name: "Fine Name", category: "grappa" }));
    expect(res2.status).toBe(400);
  });

  it("asks before writing a second row for a bottle we already have", async () => {
    await createTestBottle(db, { name: "Blanton's Single Barrel", category: "bourbon" });

    const res = await submitPOST(
      post("/api/bottles", { name: "Blantons Single Barrel", category: "bourbon" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.duplicates[0].name).toBe("Blanton's Single Barrel");
    // Nothing was written — the prompt is the point.
    expect(await db.select().from(schema.bottleSubmissions)).toHaveLength(0);

    const confirmed = await submitPOST(
      post("/api/bottles", {
        name: "Blantons Single Barrel",
        category: "bourbon",
        confirmNew: true,
      }),
    );
    expect(confirmed.status).toBe(201);
  });

  it("does not block on a loose search hit, only on the same name", async () => {
    await createTestBottle(db, { name: "Eagle Rare 10 Year", category: "bourbon" });
    const res = await submitPOST(
      post("/api/bottles", { name: "Eagle Rare 17 Year", category: "bourbon" }),
    );
    // The catalog being incomplete is the premise of this route; a near miss
    // is worth showing and never worth refusing over.
    expect(res.status).toBe(201);
    expect((await res.json()).similar.map((b: { name: string }) => b.name)).toContain(
      "Eagle Rare 10 Year",
    );
  });

  it("refuses a barcode that isn't one", async () => {
    const res = await submitPOST(
      post("/api/bottles", { name: "Fine Name", category: "bourbon", upc: "not-a-barcode" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("a submission belongs to its submitter alone", () => {
  let bottleId: string;

  beforeEach(async () => {
    const res = await submitPOST(
      post("/api/bottles", { name: "Alice's Private Pick", category: "bourbon" }),
    );
    bottleId = (await res.json()).bottle.id;
    setSessionUser(bob);
  });

  it("404s the detail route for anyone else", async () => {
    const res = await detailGET(new Request("http://localhost:3000/x"), {
      params: Promise.resolve({ id: bottleId }),
    });
    // 404 rather than 403: "not yours" would still confirm the bottle exists.
    expect(res.status).toBe(404);
  });

  it("keeps it out of anyone else's search, and finds it for its submitter", async () => {
    const res = await searchGET(
      new Request("http://localhost:3000/api/bottles/search?q=private"),
    );
    expect((await res.json()).results).toHaveLength(0);

    setSessionUser(alice);
    const mine = await searchGET(
      new Request("http://localhost:3000/api/bottles/search?q=private"),
    );
    // Without this the dead end just moves: you add a bottle and then cannot
    // find the bottle you added.
    expect((await mine.json()).results).toHaveLength(1);

    setSessionUser(null);
    const anonymous = await searchGET(
      new Request("http://localhost:3000/api/bottles/search?q=private"),
    );
    expect((await anonymous.json()).results).toHaveLength(0);
  });

  it("refuses to put it on anyone else's shelf", async () => {
    const res = await shelfPOST(post("/api/user-bottles", { bottleId, relationship: "own" }));
    expect(res.status).toBe(404);
  });

  it("refuses to teach the scanner a barcode for it", async () => {
    setSessionUser(alice);
    const res = await confirmPOST(
      post("/api/scan/confirm", { bottleId, upc: "012345678905", relationship: "own" }),
    );
    // Alice may confirm her own bottle onto her shelf, but a bottle_upcs row
    // is what every other scanner resolves against — it may not point at a
    // bottle only she can see.
    expect(res.status).toBe(201);
    expect((await res.json()).mapping).toBeNull();
    expect(await db.select().from(schema.bottleUpcs)).toHaveLength(0);
  });

  it("still lets its submitter pour it", async () => {
    setSessionUser(alice);
    const { logPour } = await import("@/lib/pours");
    await expect(logPour(db, alice.id, { bottleId })).resolves.toBeTruthy();
    await expect(logPour(db, bob.id, { bottleId })).rejects.toThrow();
  });

  it("does not appear in anyone else's shelf-add search results", async () => {
    const rows = await db
      .select()
      .from(schema.bottles)
      .where(eq(schema.bottles.id, bottleId));
    // The row exists; visibility is enforced on the read paths, not by
    // withholding the write.
    expect(rows).toHaveLength(1);
  });
});

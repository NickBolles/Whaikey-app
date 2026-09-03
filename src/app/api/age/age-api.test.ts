import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, createTestBottle, setupTestDb, setSessionUser } from "@/test/helpers";
import { POST as agePOST } from "@/app/api/age/route";
import { POST as shelfPOST } from "@/app/api/user-bottles/route";

vi.mock("@/lib/session", async () => {
  const { mockSessionModule } = await import("@/test/helpers");
  return mockSessionModule();
});

let db: DB;
let user: schema.User;

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = await setupTestDb();
  user = await createTestUser(db, { ageVerified: false });
  setSessionUser(user);
});

describe("POST /api/age", () => {
  it("needs a session", async () => {
    setSessionUser(null);
    const res = await agePOST(post("/api/age", { birthDate: "1988-04-12", market: "US" }));
    expect(res.status).toBe(401);
  });

  it("accepts an adult and opens the rest of the app", async () => {
    // Before answering, an ordinary write is refused — the gate is enforced in
    // requireUser, so it covers routes nobody had to remember to change.
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10" });
    const before = await shelfPOST(
      post("/api/user-bottles", { bottleId: bottle.id, relationship: "own" }),
    );
    expect(before.status).toBe(403);
    expect((await before.json()).reason).toBe("unknown");

    const res = await agePOST(post("/api/age", { birthDate: "1988-04-12", market: "US" }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("verified");

    const after = await shelfPOST(
      post("/api/user-bottles", { bottleId: bottle.id, relationship: "own" }),
    );
    expect(after.status).toBe(201);
  });

  it("refuses someone under the minimum, and keeps refusing after a better answer", async () => {
    const res = await agePOST(post("/api/age", { birthDate: "2012-04-12", market: "US" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: "blocked", eligibleOn: "2033-04-12" });

    // The retry is the whole point: a gate that takes a second answer is a
    // quiz with unlimited attempts.
    const retry = await agePOST(post("/api/age", { birthDate: "1970-01-01", market: "US" }));
    expect(retry.status).toBe(403);
    expect((await retry.json()).error).toMatch(/already answered/i);

    const rows = await db.select().from(schema.ageVerifications);
    expect(rows).toHaveLength(1);
    expect(rows[0].birthDate).toBe("2012-04-12");
  });

  it("rejects a date that isn't one, and a market it doesn't offer", async () => {
    expect((await agePOST(post("/api/age", { birthDate: "2026-02-30", market: "US" }))).status).toBe(400);
    expect((await agePOST(post("/api/age", { birthDate: "12/04/1988", market: "US" }))).status).toBe(400);
    expect((await agePOST(post("/api/age", { birthDate: "1988-04-12", market: "XX" }))).status).toBe(400);
    expect(await db.select().from(schema.ageVerifications)).toHaveLength(0);
  });

  it("uses the market's own minimum rather than one rule for everyone", async () => {
    // Nineteen: old enough in the UK, not in the US.
    const res = await agePOST(post("/api/age", { birthDate: "2007-01-01", market: "GB" }));
    expect(res.status).toBe(200);
  });
});

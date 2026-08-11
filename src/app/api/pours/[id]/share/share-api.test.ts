import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, mockSessionModule, setSessionUser, setupTestDb, uid } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { POST } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/pours/[id]/share", () => {
  beforeEach(async () => {
    await setupTestDb();
    setSessionUser(null);
  });

  it("creates a short public path only for the signed-in owner's pour", async () => {
    const db = getDb();
    const owner = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const [pour] = await db.insert(schema.pours).values({ id: uid("pour"), userId: owner.id, bottleId: bottle.id }).returning();
    setSessionUser(owner);

    const response = await POST(new Request("http://localhost/api/pours/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locationLabel: "Back porch" }) }), ctx(pour.id));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ path: expect.stringMatching(/^\/s\//) });
    const stored = await db.query.pourShares.findFirst();
    expect(stored?.locationLabel).toBe("Back porch");

    const other = await createTestUser(db);
    setSessionUser(other);
    const denied = await POST(new Request("http://localhost/api/pours/x", { method: "POST" }), ctx(pour.id));
    expect(denied.status).toBe(404);
  });
});

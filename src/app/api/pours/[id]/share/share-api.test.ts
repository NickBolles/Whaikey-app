import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, mockSessionModule, setSessionUser, setupTestDb, uid } from "@/test/helpers";
import { getPublicPourShare } from "@/lib/pour-sharing";

vi.mock("@/lib/session", async () => mockSessionModule());

import { DELETE, POST } from "./route";

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

describe("DELETE /api/pours/[id]/share", () => {
  beforeEach(async () => {
    await setupTestDb();
    setSessionUser(null);
  });

  it("revokes the signed-in owner's own share, idempotently, and 404s for a foreign or missing pour", async () => {
    const db = getDb();
    const owner = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const [pour] = await db.insert(schema.pours).values({ id: uid("pour"), userId: owner.id, bottleId: bottle.id }).returning();
    setSessionUser(owner);

    const created = await POST(new Request("http://localhost/api/pours/x", { method: "POST" }), ctx(pour.id));
    const { path } = (await created.json()) as { path: string };
    const code = path.split("/").pop()!;
    expect(await getPublicPourShare(db, code)).not.toBeNull();

    const revoked = await DELETE(new Request("http://localhost/api/pours/x", { method: "DELETE" }), ctx(pour.id));
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ revoked: true });
    expect(await getPublicPourShare(db, code)).toBeNull();

    // Idempotent: revoking an already-revoked share is still a clean 200.
    const revokedAgain = await DELETE(new Request("http://localhost/api/pours/x", { method: "DELETE" }), ctx(pour.id));
    expect(revokedAgain.status).toBe(200);

    // 404 for a foreign pour and for a pour that doesn't exist.
    const other = await createTestUser(db);
    setSessionUser(other);
    const foreign = await DELETE(new Request("http://localhost/api/pours/x", { method: "DELETE" }), ctx(pour.id));
    expect(foreign.status).toBe(404);
    const missing = await DELETE(new Request("http://localhost/api/pours/x", { method: "DELETE" }), ctx("not-a-real-pour"));
    expect(missing.status).toBe(404);
  });

  it("mints a fresh code when re-sharing a revoked pour, and the old code stays dead", async () => {
    const db = getDb();
    const owner = await createTestUser(db);
    const bottle = await createTestBottle(db);
    const [pour] = await db.insert(schema.pours).values({ id: uid("pour"), userId: owner.id, bottleId: bottle.id }).returning();
    setSessionUser(owner);

    const first = await POST(new Request("http://localhost/api/pours/x", { method: "POST" }), ctx(pour.id));
    const { path: firstPath } = (await first.json()) as { path: string };
    const firstCode = firstPath.split("/").pop()!;

    await DELETE(new Request("http://localhost/api/pours/x", { method: "DELETE" }), ctx(pour.id));

    const second = await POST(new Request("http://localhost/api/pours/x", { method: "POST" }), ctx(pour.id));
    expect(second.status).toBe(201);
    const { path: secondPath } = (await second.json()) as { path: string };
    const secondCode = secondPath.split("/").pop()!;

    expect(secondCode).not.toBe(firstCode);
    expect(await getPublicPourShare(db, firstCode)).toBeNull();
    expect(await getPublicPourShare(db, secondCode)).not.toBeNull();
  });
});

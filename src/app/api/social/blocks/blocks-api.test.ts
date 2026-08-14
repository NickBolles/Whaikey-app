import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { GET, POST } from "@/app/api/social/blocks/route";
import { DELETE } from "@/app/api/social/blocks/[userId]/route";
import { createProfile } from "@/lib/social";

const ctx = (userId: string) => ({ params: Promise.resolve({ userId }) });

describe("/api/social/blocks", () => {
  let db: DB;
  let user: schema.User;
  let target: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db, { name: "Blocker" });
    target = await createTestUser(db, { name: "Blocked" });
    setSessionUser(user);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(jsonRequest("/api/social/blocks", "POST", { userId: target.id }))).status).toBe(401);
    expect((await DELETE(jsonRequest("/api/social/blocks/x", "DELETE"), ctx(target.id))).status).toBe(401);
  });

  it("POST rejects self-block with 400", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "blocker");
    const res = await POST(jsonRequest("/api/social/blocks", "POST", { userId: user.id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cannot_block_self" });
  });

  it("POST works without a profile — blocking is a safety action (US-10)", async () => {
    const res = await POST(jsonRequest("/api/social/blocks", "POST", { userId: target.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST blocks a user, GET lists it, DELETE unblocks", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "blocker");

    const res = await POST(jsonRequest("/api/social/blocks", "POST", { userId: target.id }));
    expect(res.status).toBe(200);

    const listed = await GET();
    expect((await listed.json()).items).toMatchObject([{ userId: target.id }]);

    const removed = await DELETE(jsonRequest(`/api/social/blocks/${target.id}`, "DELETE"), ctx(target.id));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });

    const removedAgain = await DELETE(jsonRequest(`/api/social/blocks/${target.id}`, "DELETE"), ctx(target.id));
    expect(removedAgain.status).toBe(404);
  });
});

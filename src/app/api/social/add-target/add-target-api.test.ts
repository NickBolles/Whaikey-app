import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { GET } from "@/app/api/social/add-target/route";
import { POST as FOLLOW } from "@/app/api/social/follows/route";
import { createProfile } from "@/lib/social";

describe("/api/social/add-target", () => {
  let db: DB;
  let viewer: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    viewer = await createTestUser(db, { name: "Viewer" });
    setSessionUser(viewer);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect((await GET(jsonRequest("/api/social/add-target?handle=someone", "GET"))).status).toBe(401);
  });

  it("returns 400 when handle is missing", async () => {
    const res = await GET(jsonRequest("/api/social/add-target", "GET"));
    expect(res.status).toBe(400);
  });

  it("returns 404 for a missing handle", async () => {
    const res = await GET(jsonRequest("/api/social/add-target?handle=ghost", "GET"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the target has socialEnabled=false", async () => {
    const target = await createTestUser(db, { name: "Stepped Back" });
    await createProfile(db, { id: target.id, name: target.name }, "steppedback_at");
    await db.update(schema.userProfiles).set({ socialEnabled: false }).where(eq(schema.userProfiles.userId, target.id));

    const res = await GET(jsonRequest("/api/social/add-target?handle=steppedback_at", "GET"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when either party has blocked the other", async () => {
    const target = await createTestUser(db, { name: "Blocked Target" });
    await createProfile(db, { id: viewer.id, name: viewer.name }, "blockviewer_at");
    await createProfile(db, { id: target.id, name: target.name }, "blocktarget_at");
    await db.insert(schema.blocks).values({ id: "block1", blockerId: viewer.id, blockedId: target.id });

    const res = await GET(jsonRequest("/api/social/add-target?handle=blocktarget_at", "GET"));
    expect(res.status).toBe(404);
  });

  it("isSelf returns 200 with isSelf: true", async () => {
    await createProfile(db, { id: viewer.id, name: viewer.name }, "selftarget_at");
    const res = await GET(jsonRequest("/api/social/add-target?handle=selftarget_at", "GET"));
    expect(res.status).toBe(200);
    const { target } = await res.json();
    expect(target).toMatchObject({ isSelf: true, followState: null, followsYou: false });
  });

  it("returns identity + follow state for a reachable target, refreshable after following", async () => {
    const target = await createTestUser(db, { name: "Reachable" });
    await createProfile(db, { id: viewer.id, name: viewer.name }, "reachviewer_at");
    await createProfile(db, { id: target.id, name: target.name }, "reachtarget_at");
    await db.update(schema.userProfiles).set({ isPublic: true }).where(eq(schema.userProfiles.userId, target.id));

    const before = await GET(jsonRequest("/api/social/add-target?handle=reachtarget_at", "GET"));
    expect(before.status).toBe(200);
    expect((await before.json()).target).toMatchObject({ isSelf: false, followState: null, isPublic: true });

    await FOLLOW(jsonRequest("/api/social/follows", "POST", { handle: "reachtarget_at" }));

    const after = await GET(jsonRequest("/api/social/add-target?handle=reachtarget_at", "GET"));
    const { target: refreshed } = await after.json();
    expect(refreshed.followState).toBe("accepted");
    expect(refreshed.profile.handle).toBe("reachtarget_at");
  });
});

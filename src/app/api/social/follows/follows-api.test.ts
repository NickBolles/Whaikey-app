import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { GET, POST } from "@/app/api/social/follows/route";
import { DELETE as UNFOLLOW } from "@/app/api/social/follows/[userId]/route";
import { POST as APPROVE } from "@/app/api/social/follows/[userId]/approve/route";
import { DELETE as DENY } from "@/app/api/social/follows/[userId]/request/route";
import { DELETE as REMOVE_FOLLOWER } from "@/app/api/social/follows/[userId]/follower/route";
import { createProfile } from "@/lib/social";

const ctx = (userId: string) => ({ params: Promise.resolve({ userId }) });

describe("/api/social/follows", () => {
  let db: DB;
  let user: schema.User;
  let target: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db, { name: "Follower" });
    target = await createTestUser(db, { name: "Followee" });
    setSessionUser(user);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect((await GET(jsonRequest("/api/social/follows", "GET"))).status).toBe(401);
    expect((await POST(jsonRequest("/api/social/follows", "POST", { handle: "x" }))).status).toBe(401);
    expect((await UNFOLLOW(jsonRequest("/api/social/follows/x", "DELETE"), ctx(target.id))).status).toBe(401);
  });

  it("GET defaults to type=following and rejects an invalid type", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "follower");
    const res = await GET(jsonRequest("/api/social/follows", "GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);

    const bad = await GET(jsonRequest("/api/social/follows?type=bogus", "GET"));
    expect(bad.status).toBe(400);
  });

  it("POST returns 409 profile_required when the caller has no profile", async () => {
    const res = await POST(jsonRequest("/api/social/follows", "POST", { handle: "followee" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "profile_required" });
  });

  it("POST returns 404 not_found for an unknown handle", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "follower");
    const res = await POST(jsonRequest("/api/social/follows", "POST", { handle: "ghost" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("POST follows a public profile immediately (state accepted)", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "follower");
    await createProfile(db, { id: target.id, name: target.name }, "followee");
    await db
      .update(schema.userProfiles)
      .set({ isPublic: true })
      .where(eq(schema.userProfiles.userId, target.id));

    const res = await POST(jsonRequest("/api/social/follows", "POST", { handle: "followee" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "accepted" });

    const following = await GET(jsonRequest("/api/social/follows?type=following", "GET"));
    expect((await following.json()).items).toMatchObject([{ handle: "followee", state: "accepted" }]);
  });

  it("POST requests a private profile (state pending) and approve/deny/remove work", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "follower");
    await createProfile(db, { id: target.id, name: target.name }, "followee"); // isPublic defaults false

    const res = await POST(jsonRequest("/api/social/follows", "POST", { handle: "followee" }));
    expect(await res.json()).toEqual({ state: "pending" });

    // target sees the pending request
    setSessionUser(target);
    const requests = await GET(jsonRequest("/api/social/follows?type=requests", "GET"));
    expect((await requests.json()).items).toMatchObject([{ handle: "follower" }]);

    // deny returns 404 for an unrelated user, then succeeds for the real edge
    const otherUser = await createTestUser(db);
    const denyMiss = await DENY(jsonRequest("/api/social/follows/x/request", "DELETE"), ctx(otherUser.id));
    expect(denyMiss.status).toBe(404);

    // re-request after a deny, then approve
    setSessionUser(user);
    await POST(jsonRequest("/api/social/follows", "POST", { handle: "followee" }));
    setSessionUser(target);
    const approveMiss = await APPROVE(jsonRequest("/api/social/follows/x/approve", "POST"), ctx(otherUser.id));
    expect(approveMiss.status).toBe(404);

    const approved = await APPROVE(jsonRequest("/api/social/follows/x/approve", "POST"), ctx(user.id));
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ approved: true });

    const followers = await GET(jsonRequest("/api/social/follows?type=followers", "GET"));
    expect((await followers.json()).items).toMatchObject([{ handle: "follower" }]);

    // target removes the follower
    const removed = await REMOVE_FOLLOWER(jsonRequest("/api/social/follows/x/follower", "DELETE"), ctx(user.id));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    const removedAgain = await REMOVE_FOLLOWER(jsonRequest("/api/social/follows/x/follower", "DELETE"), ctx(user.id));
    expect(removedAgain.status).toBe(404);
  });

  it("DELETE /api/social/follows/[userId] unfollows own edge, 404 when none", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "follower");
    await createProfile(db, { id: target.id, name: target.name }, "followee");
    await db
      .update(schema.userProfiles)
      .set({ isPublic: true })
      .where(eq(schema.userProfiles.userId, target.id));
    await POST(jsonRequest("/api/social/follows", "POST", { handle: "followee" }));

    const res = await UNFOLLOW(jsonRequest(`/api/social/follows/${target.id}`, "DELETE"), ctx(target.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });

    const again = await UNFOLLOW(jsonRequest(`/api/social/follows/${target.id}`, "DELETE"), ctx(target.id));
    expect(again.status).toBe(404);
  });
});

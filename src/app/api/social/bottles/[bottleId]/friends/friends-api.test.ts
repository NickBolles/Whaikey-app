import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { GET } from "./route";
import { createProfile, followByHandle } from "@/lib/social";
import { logPour } from "@/lib/pours";

const ctx = (bottleId: string) => ({ params: Promise.resolve({ bottleId }) });

describe("GET /api/social/bottles/[bottleId]/friends", () => {
  let db: DB;
  let viewer: schema.User;
  let friend: schema.User;
  let bottle: schema.Bottle;

  beforeEach(async () => {
    db = await setupTestDb();
    viewer = await createTestUser(db, { name: "Viewer" });
    friend = await createTestUser(db, { name: "Friend" });
    bottle = await createTestBottle(db);
    const viewerProfile = await createProfile(db, { id: viewer.id, name: viewer.name }, "viewer");
    const friendProfile = await createProfile(db, { id: friend.id, name: friend.name }, "friend");
    await db
      .update(schema.userProfiles)
      .set({ isPublic: true })
      .where(eq(schema.userProfiles.userId, viewerProfile.userId));
    await db
      .update(schema.userProfiles)
      .set({ isPublic: true })
      .where(eq(schema.userProfiles.userId, friendProfile.userId));
    setSessionUser(viewer);
  });

  it("returns the latest shared note from a mutual friend, not a one-way follow", async () => {
    await followByHandle(db, viewer.id, "friend");
    await followByHandle(db, friend.id, "viewer");
    const { pour: first } = await logPour(db, friend.id, { bottleId: bottle.id, note: { nose: "oak", flavorTags: { oak: 2 } }, visibility: "friends" });
    const { pour: latest } = await logPour(db, friend.id, { bottleId: bottle.id, note: { palate: "vanilla", flavorTags: { vanilla: 3 } }, visibility: "friends" });

    const result = await GET(jsonRequest(`/api/social/bottles/${bottle.id}/friends`, "GET"), ctx(bottle.id));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      notes: [expect.objectContaining({ pourId: latest.id, author: expect.objectContaining({ handle: "friend" }) })],
    });
    expect(latest.id).not.toBe(first.id);
  });

  it("does not reveal a one-way follow's note", async () => {
    await followByHandle(db, viewer.id, "friend");
    await logPour(db, friend.id, { bottleId: bottle.id, note: { nose: "oak", flavorTags: { oak: 2 } }, visibility: "followers" });

    const result = await GET(jsonRequest(`/api/social/bottles/${bottle.id}/friends`, "GET"), ctx(bottle.id));
    expect(await result.json()).toEqual({ notes: [] });
  });
});
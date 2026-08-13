import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { DELETE, POST } from "@/app/api/social/cheers/[pourId]/route";
import { createProfile } from "@/lib/social";
import { logPour } from "@/lib/pours";

const ctx = (pourId: string) => ({ params: Promise.resolve({ pourId }) });

describe("/api/social/cheers/[pourId]", () => {
  let db: DB;
  let author: schema.User;
  let viewer: schema.User;
  let pour: schema.Pour;

  beforeEach(async () => {
    db = await setupTestDb();
    author = await createTestUser(db, { name: "Author" });
    viewer = await createTestUser(db, { name: "Viewer" });
    const bottle = await createTestBottle(db);
    await createProfile(db, { id: author.id, name: author.name }, "author");
    ({ pour } = await logPour(db, author.id, { bottleId: bottle.id, rating: 4, visibility: "public" }));
    setSessionUser(viewer);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect((await POST(jsonRequest("/api/social/cheers/x", "POST"), ctx(pour.id))).status).toBe(401);
    expect((await DELETE(jsonRequest("/api/social/cheers/x", "DELETE"), ctx(pour.id))).status).toBe(401);
  });

  it("POST returns 409 profile_required when the caller has no profile", async () => {
    const res = await POST(jsonRequest("/api/social/cheers/x", "POST"), ctx(pour.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "profile_required" });
  });

  it("POST returns 404 not_found for a pour the caller cannot see", async () => {
    await createProfile(db, { id: viewer.id, name: viewer.name }, "viewer");
    const bottle = await createTestBottle(db);
    const { pour: privatePour } = await logPour(db, author.id, { bottleId: bottle.id, rating: 3 }); // private default
    const res = await POST(jsonRequest("/api/social/cheers/x", "POST"), ctx(privatePour.id));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("POST cheers a visible pour and DELETE removes it, returning cheersCount", async () => {
    await createProfile(db, { id: viewer.id, name: viewer.name }, "viewer");

    const cheered = await POST(jsonRequest("/api/social/cheers/x", "POST"), ctx(pour.id));
    expect(cheered.status).toBe(200);
    expect(await cheered.json()).toEqual({ cheersCount: 1 });

    // idempotent
    const cheeredAgain = await POST(jsonRequest("/api/social/cheers/x", "POST"), ctx(pour.id));
    expect(await cheeredAgain.json()).toEqual({ cheersCount: 1 });

    const uncheered = await DELETE(jsonRequest("/api/social/cheers/x", "DELETE"), ctx(pour.id));
    expect(uncheered.status).toBe(200);
    expect(await uncheered.json()).toEqual({ cheersCount: 0 });
  });

  it("DELETE returns 404 not_found for an unviewable pour", async () => {
    const bottle = await createTestBottle(db);
    const { pour: privatePour } = await logPour(db, author.id, { bottleId: bottle.id, rating: 3 });
    const res = await DELETE(jsonRequest("/api/social/cheers/x", "DELETE"), ctx(privatePour.id));
    expect(res.status).toBe(404);
  });
});

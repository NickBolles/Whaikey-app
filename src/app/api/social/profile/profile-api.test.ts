import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { GET, PATCH, POST } from "@/app/api/social/profile/route";
import { createProfile } from "@/lib/social";

describe("/api/social/profile", () => {
  let db: DB;
  let user: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db, { name: "Sam Taster" });
    setSessionUser(user);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(jsonRequest("/api/social/profile", "POST", { handle: "sam" }))).status).toBe(401);
    expect((await PATCH(jsonRequest("/api/social/profile", "PATCH", {}))).status).toBe(401);
  });

  it("GET returns null profile and default prefs before any profile exists", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toBeNull();
    expect(body.prefs).toEqual({ defaultPourVisibility: "private", allowComments: true });
  });

  it("POST creates a profile and returns 201", async () => {
    const res = await POST(
      jsonRequest("/api/social/profile", "POST", { handle: "SamT", bio: "Bourbon guy", isPublic: true }),
    );
    expect(res.status).toBe(201);
    const profile = await res.json();
    expect(profile.handle).toBe("samt");
    expect(profile.bio).toBe("Bourbon guy");
    expect(profile.isPublic).toBe(true);
    expect(profile.displayName).toBe("Sam Taster");

    const getRes = await GET();
    expect((await getRes.json()).profile.handle).toBe("samt");
  });

  it("POST rejects an invalid handle with 400 invalid_handle", async () => {
    const res = await POST(jsonRequest("/api/social/profile", "POST", { handle: "a" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_handle" });
  });

  it("POST returns 409 handle_taken when another user has the handle", async () => {
    const other = await createTestUser(db);
    setSessionUser(other);
    await POST(jsonRequest("/api/social/profile", "POST", { handle: "grabbed" }));

    setSessionUser(user);
    const res = await POST(jsonRequest("/api/social/profile", "POST", { handle: "grabbed" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "handle_taken" });
  });

  it("POST returns 409 profile_exists when the caller already has a profile", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "samt");
    const res = await POST(jsonRequest("/api/social/profile", "POST", { handle: "other" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "profile_exists" });
  });

  it("POST rejects malformed body with 400", async () => {
    const res = await POST(jsonRequest("/api/social/profile", "POST", {}));
    expect(res.status).toBe(400);
  });

  it("PATCH returns 404 when the caller has no profile", async () => {
    const res = await PATCH(jsonRequest("/api/social/profile", "PATCH", { bio: "hi" }));
    expect(res.status).toBe(404);
  });

  it("PATCH edits profile fields", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "samt");
    const res = await PATCH(jsonRequest("/api/social/profile", "PATCH", { bio: "New bio", isPublic: true }));
    expect(res.status).toBe(200);
    const profile = await res.json();
    expect(profile.bio).toBe("New bio");
    expect(profile.isPublic).toBe(true);
  });

  it("PATCH socialEnabled toggles the reversible switch without touching other fields", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "samt");
    const off = await PATCH(jsonRequest("/api/social/profile", "PATCH", { socialEnabled: false }));
    expect(off.status).toBe(200);
    expect((await off.json()).socialEnabled).toBe(false);

    const on = await PATCH(jsonRequest("/api/social/profile", "PATCH", { socialEnabled: true }));
    expect((await on.json()).socialEnabled).toBe(true);
  });
});

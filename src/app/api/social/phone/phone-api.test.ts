import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { DELETE, PATCH, POST } from "@/app/api/social/phone/route";
import { PHONE_LOOKUP_LIMIT_PER_HOUR, createProfile } from "@/lib/social";

describe("/api/social/phone", () => {
  let db: DB;
  let user: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db, { name: "Phone User" });
    setSessionUser(user);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect((await POST(jsonRequest("/api/social/phone", "POST", { phone: "4155550123", discoverable: true }))).status).toBe(
      401,
    );
    expect((await DELETE()).status).toBe(401);
    expect((await PATCH(jsonRequest("/api/social/phone", "PATCH", { discoverable: true }))).status).toBe(401);
  });

  it("POST returns 409 profile_required when the caller has no profile", async () => {
    const res = await POST(jsonRequest("/api/social/phone", "POST", { phone: "4155550123", discoverable: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "profile_required" });
  });

  it("POST returns 400 invalid_phone for a malformed number or a malformed body", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "phoneuser");

    const malformedNumber = await POST(jsonRequest("/api/social/phone", "POST", { phone: "not a phone", discoverable: true }));
    expect(malformedNumber.status).toBe(400);
    expect(await malformedNumber.json()).toEqual({ error: "invalid_phone" });

    const missingField = await POST(jsonRequest("/api/social/phone", "POST", { phone: "4155550123" }));
    expect(missingField.status).toBe(400);
  });

  it("POST sets the phone and returns { phoneLast2, phoneDiscoverable } — never the raw number", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "phoneuser2");

    const res = await POST(jsonRequest("/api/social/phone", "POST", { phone: "(415) 555-0123", discoverable: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ phoneLast2: "23", phoneDiscoverable: true });
    expect(JSON.stringify(body)).not.toContain("4155550123");

    const row = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, user.id) });
    expect(row?.phoneHash).toBeTruthy();
    expect(row?.phoneHash).not.toContain("4155550123");
  });

  it("POST returns 409 phone_taken when another account already claimed the number", async () => {
    const other = await createTestUser(db, { name: "Other" });
    await createProfile(db, { id: other.id, name: other.name }, "phoneother");
    setSessionUser(other);
    await POST(jsonRequest("/api/social/phone", "POST", { phone: "4155550199", discoverable: false }));

    setSessionUser(user);
    await createProfile(db, { id: user.id, name: user.name }, "phoneuser3");
    const res = await POST(jsonRequest("/api/social/phone", "POST", { phone: "4155550199", discoverable: false }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "phone_taken" });
  });

  it("POST returns 409 social_disabled when setting discoverable=true while stepped back", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "phoneuser4");
    await db.update(schema.userProfiles).set({ socialEnabled: false }).where(eq(schema.userProfiles.userId, user.id));

    const res = await POST(jsonRequest("/api/social/phone", "POST", { phone: "4155550123", discoverable: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "social_disabled" });

    // discoverable=false is always allowed, even stepped back.
    const allowed = await POST(jsonRequest("/api/social/phone", "POST", { phone: "4155550123", discoverable: false }));
    expect(allowed.status).toBe(200);
  });

  it("POST returns 429 rate_limited once the shared phone-probe budget is spent", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "phoneuser7");
    for (let i = 0; i < PHONE_LOOKUP_LIMIT_PER_HOUR; i += 1) {
      await db.insert(schema.phoneLookups).values({ id: crypto.randomUUID(), userId: user.id });
    }

    const res = await POST(jsonRequest("/api/social/phone", "POST", { phone: "4155550123", discoverable: false }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("DELETE removes the phone and returns { removed }", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "phoneuser5");
    await POST(jsonRequest("/api/social/phone", "POST", { phone: "4155550123", discoverable: true }));

    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });

    const row = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, user.id) });
    expect(row?.phoneHash).toBeNull();
    expect(row?.phoneDiscoverable).toBe(false);

    const noProfileUser = await createTestUser(db);
    setSessionUser(noProfileUser);
    const noProfileRes = await DELETE();
    expect(await noProfileRes.json()).toEqual({ removed: false });
  });

  it("PATCH flips discoverable; 404 without a profile, 409 social_disabled while stepped back", async () => {
    const noProfileUser = await createTestUser(db);
    setSessionUser(noProfileUser);
    const missing = await PATCH(jsonRequest("/api/social/phone", "PATCH", { discoverable: true }));
    expect(missing.status).toBe(404);

    setSessionUser(user);
    await createProfile(db, { id: user.id, name: user.name }, "phoneuser6");
    await POST(jsonRequest("/api/social/phone", "POST", { phone: "4155550123", discoverable: false }));

    const res = await PATCH(jsonRequest("/api/social/phone", "PATCH", { discoverable: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ phoneDiscoverable: true });

    await db.update(schema.userProfiles).set({ socialEnabled: false }).where(eq(schema.userProfiles.userId, user.id));
    const disabled = await PATCH(jsonRequest("/api/social/phone", "PATCH", { discoverable: true }));
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toEqual({ error: "social_disabled" });
  });
});

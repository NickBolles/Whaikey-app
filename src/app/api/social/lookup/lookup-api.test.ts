import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { POST } from "@/app/api/social/lookup/route";
import { POST as SET_PHONE } from "@/app/api/social/phone/route";
import { PHONE_LOOKUP_LIMIT_PER_HOUR, createProfile } from "@/lib/social";

describe("/api/social/lookup", () => {
  let db: DB;
  let user: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db, { name: "Looker" });
    setSessionUser(user);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect((await POST(jsonRequest("/api/social/lookup", "POST", { phone: "4155550123" }))).status).toBe(401);
  });

  it("does NOT require a profile — finding people is how you start", async () => {
    const res = await POST(jsonRequest("/api/social/lookup", "POST", { phone: "4155550123" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: null });
  });

  it("returns 400 invalid_phone for a malformed number or a malformed body", async () => {
    const malformed = await POST(jsonRequest("/api/social/lookup", "POST", { phone: "not a phone" }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_phone" });

    const missing = await POST(jsonRequest("/api/social/lookup", "POST", {}));
    expect(missing.status).toBe(400);
  });

  it("returns { profile: null } for a real but non-discoverable number — no oracle", async () => {
    const target = await createTestUser(db, { name: "Target" });
    await createProfile(db, { id: target.id, name: target.name }, "hiddentarget");
    setSessionUser(target);
    await SET_PHONE(jsonRequest("/api/social/phone", "POST", { phone: "4155550123", discoverable: false }));

    setSessionUser(user);
    const res = await POST(jsonRequest("/api/social/lookup", "POST", { phone: "4155550123" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: null });
  });

  it("returns the matching ProfileSummary for a discoverable number", async () => {
    const target = await createTestUser(db, { name: "Findable" });
    await createProfile(db, { id: target.id, name: target.name }, "findabletarget");
    setSessionUser(target);
    await SET_PHONE(jsonRequest("/api/social/phone", "POST", { phone: "4155550199", discoverable: true }));

    setSessionUser(user);
    const res = await POST(jsonRequest("/api/social/lookup", "POST", { phone: "4155550199" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      profile: { userId: target.id, handle: "findabletarget", displayName: "Findable", avatarUrl: null },
    });
  });

  it("returns 429 rate_limited past PHONE_LOOKUP_LIMIT_PER_HOUR, counting misses", async () => {
    for (let i = 0; i < PHONE_LOOKUP_LIMIT_PER_HOUR; i += 1) {
      const res = await POST(jsonRequest("/api/social/lookup", "POST", { phone: `415555${9000 + i}` }));
      expect(res.status).toBe(200);
    }
    const limited = await POST(jsonRequest("/api/social/lookup", "POST", { phone: "4155559999" }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });

    const rows = await db.query.phoneLookups.findMany({ where: eq(schema.phoneLookups.userId, user.id) });
    expect(rows).toHaveLength(PHONE_LOOKUP_LIMIT_PER_HOUR);
  });
});

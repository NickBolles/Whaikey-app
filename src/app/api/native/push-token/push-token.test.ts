import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import {
  createTestUser,
  jsonRequest,
  mockSessionModule,
  setSessionUser,
  setupTestDb,
} from "@/test/helpers";
import { DELETE, POST } from "./route";

vi.mock("@/lib/session", async () => mockSessionModule());

describe("/api/native/push-token", () => {
  let db: DB;
  let user: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db);
    setSessionUser(user);
  });

  function post(body: unknown) {
    return POST(jsonRequest("/api/native/push-token", "POST", body));
  }

  async function devices() {
    return db.select().from(schema.pushDevices);
  }

  it("registers a device token", async () => {
    const res = await post({ token: "apns-token-1", platform: "ios" });
    expect(res.status).toBe(201);

    const rows = await devices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: user.id, token: "apns-token-1", platform: "ios" });
  });

  it("is idempotent — re-registering the same device does not duplicate it", async () => {
    // Every app launch may re-register; the token is the device's identity.
    await post({ token: "apns-token-1", platform: "ios" });
    await post({ token: "apns-token-1", platform: "ios" });
    expect(await devices()).toHaveLength(1);
  });

  /**
   * Review SEC-M6. This used to reassign the token to whoever POSTed it, on
   * the reasoning that a token identifies a device rather than a person —
   * which is true, and beside the point: the token is the only credential in
   * play and it is exactly the thing that leaks. Anyone who learned a victim's
   * token took their notifications with it.
   */
  it("refuses to move a live token to whoever asks", async () => {
    await post({ token: "shared-device", platform: "android" });

    const other = await createTestUser(db, { email: "friend@example.com" });
    setSessionUser(other);
    const res = await post({ token: "shared-device", platform: "android" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("token_claimed");

    const rows = await devices();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).not.toBe(other.id);
  });

  /**
   * The device genuinely changing hands is still supported — it goes through
   * the owner releasing it. Sign-out deletes the row, and the next person gets
   * the token immediately rather than waiting out the staleness window.
   */
  it("hands the token straight over once its owner signs out", async () => {
    await post({ token: "shared-device", platform: "android" });
    const signedOut = await DELETE(
      new Request("http://localhost:3000/api/native/push-token", { method: "DELETE" }),
    );
    expect(signedOut.status).toBe(200);

    const other = await createTestUser(db, { email: "friend@example.com" });
    setSessionUser(other);
    expect((await post({ token: "shared-device", platform: "android" })).status).toBe(201);

    const rows = await devices();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(other.id);
  });

  it("rejects a malformed body with details", async () => {
    const res = await post({ token: "", platform: "windows" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid input");
    expect(body.details.length).toBeGreaterThan(0);
  });

  it("requires a session", async () => {
    setSessionUser(null);
    expect((await post({ token: "t", platform: "ios" })).status).toBe(401);
  });

  it("unregisters every device for the user on sign-out", async () => {
    await post({ token: "device-a", platform: "ios" });
    await post({ token: "device-b", platform: "android" });

    const res = await DELETE(new Request("http://localhost:3000/api/native/push-token", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await devices()).toHaveLength(0);
  });

  it("unregisters a single device when a token is given", async () => {
    await post({ token: "device-a", platform: "ios" });
    await post({ token: "device-b", platform: "android" });

    await DELETE(
      new Request("http://localhost:3000/api/native/push-token?token=device-a", {
        method: "DELETE",
      }),
    );

    const rows = await devices();
    expect(rows.map((row) => row.token)).toEqual(["device-b"]);
  });

  it("never deletes another user's devices", async () => {
    await post({ token: "mine", platform: "ios" });
    const other = await createTestUser(db, { email: "other@example.com" });
    setSessionUser(other);
    await post({ token: "theirs", platform: "ios" });

    // Signed in as `other`, delete-all must leave the first user untouched.
    await DELETE(new Request("http://localhost:3000/api/native/push-token", { method: "DELETE" }));

    const remaining = await db
      .select()
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.userId, user.id));
    expect(remaining.map((row) => row.token)).toEqual(["mine"]);
  });
});

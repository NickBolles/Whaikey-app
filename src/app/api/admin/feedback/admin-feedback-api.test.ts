import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb, setSessionUser, uid } from "@/test/helpers";
import { POST as markHandled } from "./route";

vi.mock("@/lib/session", async () => {
  const { mockSessionModule } = await import("@/test/helpers");
  return mockSessionModule();
});

let db: DB;
let operator: schema.User;
let other: schema.User;
let messageId: string;

function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/admin/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = await setupTestDb();
  operator = await createTestUser(db, { name: "Op" });
  other = await createTestUser(db, { name: "Someone" });
  messageId = uid("feedback");
  await db.insert(schema.feedback).values({
    id: messageId,
    body: "Signing in with Google bounces me straight back.",
    createdAt: new Date(),
  });
  process.env.WHAIKEY_OPERATOR_IDS = operator.id;
  setSessionUser(operator);
});

afterEach(() => {
  delete process.env.WHAIKEY_OPERATOR_IDS;
});

describe("POST /api/admin/feedback", () => {
  it("does not exist for anyone who is not an operator", async () => {
    setSessionUser(other);
    expect((await markHandled(post({ id: messageId }))).status).toBe(404);
  });

  /** `handledAt` is what makes this a queue rather than a pile. */
  it("marks a message handled, once", async () => {
    expect((await markHandled(post({ id: messageId }))).status).toBe(200);
    const row = await db.query.feedback.findFirst({ where: eq(schema.feedback.id, messageId) });
    expect(row?.handledAt).toBeInstanceOf(Date);

    // Already handled is a 404 rather than a silent second write, so two
    // operators working the same page don't overwrite each other's timestamp.
    expect((await markHandled(post({ id: messageId }))).status).toBe(404);
  });
});

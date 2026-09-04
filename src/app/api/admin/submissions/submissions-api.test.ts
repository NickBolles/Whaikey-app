import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb, setSessionUser } from "@/test/helpers";
import { submitBottle } from "@/lib/catalog";
import { POST as submissionsPOST } from "./route";

vi.mock("@/lib/session", async () => {
  const { mockSessionModule } = await import("@/test/helpers");
  return mockSessionModule();
});

let db: DB;
let operator: schema.User;
let submitter: schema.User;

function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/admin/submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = await setupTestDb();
  operator = await createTestUser(db, { name: "Op" });
  submitter = await createTestUser(db, { name: "Submitter" });
  process.env.WHAIKEY_OPERATOR_IDS = operator.id;
  setSessionUser(operator);
});

afterEach(() => {
  delete process.env.WHAIKEY_OPERATOR_IDS;
});

describe("POST /api/admin/submissions", () => {
  it("gives a signed-out caller the same 404 as any other non-operator", async () => {
    setSessionUser(null);
    expect((await submissionsPOST(post({ action: "approve", submissionId: "x" }))).status).toBe(404);
  });

  /** 404, not 403 — same reason as the moderation endpoint. */
  it("does not exist for anyone who is not an operator", async () => {
    setSessionUser(submitter);
    expect((await submissionsPOST(post({ action: "approve", submissionId: "x" }))).status).toBe(404);
  });

  it("approves a submission into the catalog", async () => {
    const { bottle, submissionId } = await submitBottle(db, submitter.id, {
      name: "Reviewed Rye",
      category: "rye",
    });

    expect((await submissionsPOST(post({ action: "approve", submissionId }))).status).toBe(200);
    const after = await db.query.bottles.findFirst({ where: eq(schema.bottles.id, bottle.id) });
    expect(after?.status).toBe("verified");
  });

  it("will not decline without a reason the submitter can read", async () => {
    const { submissionId } = await submitBottle(db, submitter.id, {
      name: "No Reason",
      category: "rye",
    });
    expect((await submissionsPOST(post({ action: "reject", submissionId, reason: " " }))).status).toBe(
      400,
    );
    const row = await db.query.bottleSubmissions.findFirst({
      where: eq(schema.bottleSubmissions.id, submissionId),
    });
    expect(row?.state).toBe("pending");
  });

  it("404s a decision about a submission that isn't waiting", async () => {
    expect((await submissionsPOST(post({ action: "approve", submissionId: "nope" }))).status).toBe(
      404,
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, setSessionUser, uid } from "@/test/helpers";
import { POST as moderationPOST } from "./route";
import { listSuspendedAccounts } from "@/lib/moderation";

vi.mock("@/lib/session", async () => {
  const { mockSessionModule } = await import("@/test/helpers");
  return mockSessionModule();
});

let db: DB;
let operator: schema.User;
let author: schema.User;
let reporter: schema.User;

function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/admin/moderation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = await setupTestDb();
  operator = await createTestUser(db, { name: "Op" });
  author = await createTestUser(db, { name: "Author" });
  reporter = await createTestUser(db, { name: "Reporter" });
  for (const [u, handle] of [
    [author, "author"],
    [reporter, "reporter"],
  ] as const) {
    await db.insert(schema.userProfiles).values({
      userId: u.id,
      handle,
      displayName: u.name,
      socialEnabled: true,
    });
  }
  process.env.WHAIKEY_OPERATOR_IDS = operator.id;
  setSessionUser(operator);
});

afterEach(() => {
  delete process.env.WHAIKEY_OPERATOR_IDS;
});

describe("POST /api/admin/moderation", () => {
  /**
   * 404 signed out too, not 401. A 401 here and a 404 for a signed-in stranger
   * lets an anonymous prober tell a real admin endpoint from a wrong URL,
   * which is the whole thing the 404 was for.
   */
  it("gives everyone who is not an operator the same answer", async () => {
    setSessionUser(null);
    expect((await moderationPOST(post({ action: "dismiss", reportId: "x" }))).status).toBe(404);
    setSessionUser(author);
    expect((await moderationPOST(post({ action: "dismiss", reportId: "x" }))).status).toBe(404);
  });

  it("hides a reported comment and closes the report", async () => {
    const bottle = await createTestBottle(db);
    const pourId = uid("pour");
    await db.insert(schema.pours).values({ id: pourId, userId: reporter.id, bottleId: bottle.id });
    const commentId = uid("comment");
    await db.insert(schema.comments).values({ id: commentId, pourId, userId: author.id, body: "no" });
    const reportId = uid("report");
    await db.insert(schema.reports).values({
      id: reportId,
      subjectType: "comment",
      subjectId: commentId,
      reporterId: reporter.id,
      reason: "abuse",
    });

    const res = await moderationPOST(
      post({ action: "hide", subjectType: "comment", subjectId: commentId, reportId, note: "abusive" }),
    );
    expect(res.status).toBe(200);

    const [comment] = await db.select().from(schema.comments).where(eq(schema.comments.id, commentId));
    expect(comment.deletedAt).not.toBeNull();
    const [report] = await db.select().from(schema.reports).where(eq(schema.reports.id, reportId));
    expect(report.state).toBe("resolved");
    const [action] = await db.select().from(schema.moderationActions);
    expect(action).toMatchObject({ action: "hide", actorId: operator.id, note: "abusive" });
  });

  it("will not suspend without a reason the account can appeal", async () => {
    const res = await moderationPOST(post({ action: "suspend", userId: author.id, reason: "  " }));
    expect(res.status).toBe(400);
    expect(await db.select().from(schema.moderationActions)).toHaveLength(0);
  });

  it("suspends with one, and reinstates", async () => {
    expect(
      (await moderationPOST(post({ action: "suspend", userId: author.id, reason: "abuse" }))).status,
    ).toBe(200);
    let [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, author.id));
    expect(profile.suspendedAt).not.toBeNull();

    // Naming the suspension is required, not optional: a guard that can be
    // omitted is one a stale client bundle omits.
    expect(
      (await moderationPOST(post({ action: "reinstate", userId: author.id }))).status,
    ).toBe(400);

    // The action in force, which is what the guard names — a timestamp cannot
    // tell two suspensions in the same millisecond apart.
    async function standingSuspensionId(): Promise<string> {
      const { accounts } = await listSuspendedAccounts(db);
      const hit = accounts.find((a) => a.userId === author.id);
      if (!hit?.suspensionId) throw new Error("no standing suspension");
      return hit.suspensionId;
    }

    // And a reason, like every other action: reversing a decision is a
    // decision, and "why was this put back" is an appeal question too.
    expect(
      (
        await moderationPOST(
          post({
            action: "reinstate",
            userId: author.id,
            expectedActionId: await standingSuspensionId(),
          }),
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await moderationPOST(
          post({
            action: "reinstate",
            userId: author.id,
            note: "appeal upheld",
            expectedActionId: await standingSuspensionId(),
          }),
        )
      ).status,
    ).toBe(200);
    [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, author.id));
    expect(profile.suspendedAt).toBeNull();
  });

  /**
   * Rejected by the schema, before anything reaches the database: a profile
   * has no hide that sticks, so offering one would tell the operator they had
   * acted when its owner can undo it from their own settings.
   */
  it("will not hide a profile — that action is suspend", async () => {
    const res = await moderationPOST(
      post({ action: "hide", subjectType: "profile", subjectId: author.id, note: "abusive" }),
    );
    expect(res.status).toBe(400);
    const [profile] = await db
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, author.id));
    expect(profile.socialEnabled).toBe(true);
    expect(await db.select().from(schema.moderationActions)).toHaveLength(0);
  });

  /**
   * A hide is not reversible by its author, so the note is the only thing
   * there is to appeal against — and the Terms say they get one.
   */
  it("will not hide without a reason the author can appeal", async () => {
    const res = await moderationPOST(
      post({ action: "hide", subjectType: "pour", subjectId: "anything", note: "   " }),
    );
    expect(res.status).toBe(400);
    expect(await db.select().from(schema.moderationActions)).toHaveLength(0);
  });

  /**
   * PLAN §9.4 and the Terms say every moderation action records why. A report
   * closed with no reason is the case its reporter is most likely to come back
   * about, and a reversal with none is the case its subject will.
   */
  it("will not dismiss without a reason either", async () => {
    const reportId = uid("report");
    await db.insert(schema.reports).values({
      id: reportId,
      subjectType: "profile",
      subjectId: author.id,
      reporterId: reporter.id,
      reason: "abuse",
    });

    expect((await moderationPOST(post({ action: "dismiss", reportId }))).status).toBe(400);
    expect(
      (await moderationPOST(post({ action: "dismiss", reportId, note: "not a violation" }))).status,
    ).toBe(200);
  });

  it("404s an action against something that isn't there", async () => {
    const res = await moderationPOST(
      post({ action: "hide", subjectType: "pour", subjectId: "nope", note: "abusive" }),
    );
    expect(res.status).toBe(404);
  });
});

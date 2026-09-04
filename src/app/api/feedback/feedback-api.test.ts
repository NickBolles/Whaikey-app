import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb, setSessionUser } from "@/test/helpers";
import { POST as feedbackPOST } from "./route";

vi.mock("@/lib/session", async () => {
  const { mockSessionModule } = await import("@/test/helpers");
  return mockSessionModule();
});

/**
 * PLAN.md §9.7 and review §5.4: a store submission needs a support route that
 * is not a GitHub issue form. Stored rather than mailed, because there is no
 * mailer — an email to an address nobody configured is a silent drop.
 */
let db: DB;

function post(body: unknown, ip = "203.0.113.1"): Request {
  return new Request("http://localhost:3000/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = await setupTestDb();
  setSessionUser(null);
});

describe("POST /api/feedback", () => {
  it("takes a message from somebody signed out", async () => {
    const res = await feedbackPOST(
      post({ body: "The scanner never finds my bottle.", contact: "me@example.com", platform: "ios" }),
    );
    expect(res.status).toBe(201);

    const [row] = await db.select().from(schema.feedback);
    expect(row).toMatchObject({
      userId: null,
      contact: "me@example.com",
      platform: "ios",
    });
  });

  it("attaches the account when there is one", async () => {
    const user = await createTestUser(db);
    setSessionUser(user);
    await feedbackPOST(post({ body: "A note that is long enough to be useful." }));

    const [row] = await db.select().from(schema.feedback);
    expect(row.userId).toBe(user.id);
  });

  it("wants a sentence, not a keystroke", async () => {
    expect((await feedbackPOST(post({ body: "help" }))).status).toBe(400);
    expect(await db.select().from(schema.feedback)).toHaveLength(0);
  });

  /**
   * The bound that matters here is the one on a single client, not one shared
   * allowance for everybody signed out: an outage is precisely when many
   * people write at once, and a global counter would turn that into a silent
   * drop for all but the first few.
   */
  it("bounds one signed-out client without silencing the next person", async () => {
    // Its own address: the counter is module state and deliberately outlives a
    // test database, so a shared address would carry the other tests' posts in.
    const mine = "203.0.113.55";
    for (let i = 0; i < 5; i++) {
      const res = await feedbackPOST(post({ body: `Sign-in bounces me, attempt ${i}.` }, mine));
      expect(res.status).toBe(201);
    }
    expect((await feedbackPOST(post({ body: "Still cannot sign in at all." }, mine))).status).toBe(
      429,
    );

    // Somebody else reporting the same outage still gets through.
    const other = await feedbackPOST(
      post({ body: "Sign-in bounces me too, from another machine." }, "198.51.100.7"),
    );
    expect(other.status).toBe(201);
  });

  /**
   * Counting outside the write lets several concurrent requests all read
   * four-of-five and all insert. The count and the insert share one
   * transaction behind a per-user advisory lock, the same shape as the report
   * and submission limiters.
   */
  it("holds the account bound when requests arrive together", async () => {
    const user = await createTestUser(db);
    setSessionUser(user);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        feedbackPOST(post({ body: `All at once, message number ${i}.` })),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(await db.select().from(schema.feedback)).toHaveLength(5);
  });

  it("bounds how much one account can send", async () => {
    const user = await createTestUser(db);
    setSessionUser(user);
    for (let i = 0; i < 5; i++) {
      await feedbackPOST(post({ body: `Something went wrong, attempt ${i}.` }));
    }
    const res = await feedbackPOST(post({ body: "And one more for good measure." }));
    expect(res.status).toBe(429);
    expect(await db.select().from(schema.feedback)).toHaveLength(5);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb, uid } from "@/test/helpers";
import { listFeedback } from "./feedback";

let db: DB;

beforeEach(async () => {
  db = await setupTestDb();
});

async function add(body: string, createdAt: string, handledAt: string | null, userId?: string) {
  await db.insert(schema.feedback).values({
    id: uid("feedback"),
    userId: userId ?? null,
    body,
    createdAt: new Date(createdAt),
    handledAt: handledAt ? new Date(handledAt) : null,
  });
}

describe("listFeedback", () => {
  /**
   * A support inbox sorted newest-first buries whatever has waited longest,
   * which is the failure the report queue's ordering exists to avoid. Handled
   * messages are history and read the other way round.
   */
  it("puts what is outstanding first, oldest of those at the top", async () => {
    await add("open-new", "2026-09-03T00:00:00Z", null);
    await add("open-old", "2026-09-01T00:00:00Z", null);
    await add("done-old", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
    await add("done-new", "2026-08-20T00:00:00Z", "2026-09-02T00:00:00Z");

    const rows = await listFeedback(db);
    expect(rows.map((r) => r.body)).toEqual(["open-old", "open-new", "done-new", "done-old"]);
  });

  it("names the sender when there is one and says nothing when there isn't", async () => {
    const user = await createTestUser(db, { name: "Robin" });
    await add("from an account", "2026-09-02T00:00:00Z", null, user.id);
    await add("from nobody in particular", "2026-09-01T00:00:00Z", null);

    const rows = await listFeedback(db);
    expect(rows[0]).toMatchObject({ body: "from nobody in particular", senderName: null });
    expect(rows[1]).toMatchObject({ body: "from an account", senderName: "Robin" });
  });
});

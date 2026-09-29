import type { DB } from "../src/db/index";
import * as schema from "../src/db/schema";
import { ACCOUNT_SESSION_TOKEN, ACCOUNT_USER_ID, LEAVING_SESSION_TOKEN, LEAVING_USER_ID } from "./fixtures";

const D = (iso: string) => new Date(iso);

/**
 * The Settings smoke's two disposable accounts (e2e/account-smoke.spec.ts).
 *
 * Each has one pour with a note, so the export has something recognisable in
 * it and the deletion has something to remove. Kept out of demo-seed.ts: they
 * are consumed by the tests that use them, and nothing else should lean on
 * them existing.
 */
export async function seedAccountUsers(db: DB): Promise<void> {
  for (const [userId, token, name, note] of [
    [ACCOUNT_USER_ID, ACCOUNT_SESSION_TOKEN, "Avery Exporter", "Export me: toffee and orange peel"],
    [LEAVING_USER_ID, LEAVING_SESSION_TOKEN, "Lee Leaving", "Delete me: smoke and brine"],
  ] as const) {
    await db.insert(schema.user).values({
      id: userId,
      name,
      email: `${userId}@whaikey.app`,
      emailVerified: true,
      createdAt: D("2026-03-01T12:00:00Z"),
      updatedAt: D("2026-03-01T12:00:00Z"),
    });
    await db.insert(schema.session).values({
      id: `${userId}-session`,
      token,
      userId,
      expiresAt: D("2030-01-01T00:00:00Z"),
      createdAt: D("2026-07-01T12:00:00Z"),
      updatedAt: D("2026-07-01T12:00:00Z"),
    });
    await db.insert(schema.ageVerifications).values({
      userId,
      birthDate: "1985-06-01",
      market: "US",
      minimumAge: 21,
      passed: true,
      eligibleOn: null,
      createdAt: D("2026-03-01T12:00:00Z"),
    });
    const pourId = `${userId}-pour`;
    await db.insert(schema.pours).values({
      id: pourId,
      userId,
      bottleId: "eagle-rare-10",
      rating: 4,
      visibility: "private",
      createdAt: D("2026-07-10T20:00:00Z"),
    });
    await db.insert(schema.tastingNotes).values({ id: `${userId}-note`, pourId, freeform: note });
  }
}

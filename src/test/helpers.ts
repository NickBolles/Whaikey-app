import { sql } from "drizzle-orm";
import { vi } from "vitest";
import { createDb, setDb, type DB } from "@/db";
import { migrateDb } from "@/db/migrate";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/lib/session";

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}_${Math.abs(counter * 2654435761 % 1e9).toString(36)}`;
}

// Booting PGlite (WASM Postgres) + migrating on every test would be slow, so we
// stand up one in-memory instance per worker and truncate all app tables
// between tests — same fresh-DB isolation, a fraction of the cost.
let sharedDb: DB | undefined;

/** True once the app schema (a representative core table) exists. */
async function schemaReady(db: DB): Promise<boolean> {
  const rows = await db.execute(sql`SELECT to_regclass('public.bottles') AS t`);
  const list = (rows as unknown as { rows?: Array<{ t: string | null }> }).rows ?? (rows as unknown as Array<{ t: string | null }>);
  return Boolean(list[0]?.t);
}

async function truncateAll(db: DB): Promise<void> {
  await db.execute(sql`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
}

/**
 * Return a migrated, empty in-memory Postgres (PGlite) and install it as the
 * app singleton so route handlers under test hit it. Call in beforeEach.
 *
 * The singleton is only cached *after* migrations succeed, and the cached
 * handle is re-verified each call. Under heavy parallel load a migration can be
 * slow or interrupted; without these guards a half-initialized handle would be
 * reused and every later test in the worker would fail with
 * `relation "…" does not exist`. Here a bad handle is rebuilt instead.
 */
export async function setupTestDb(): Promise<DB> {
  if (sharedDb && (await schemaReady(sharedDb))) {
    await truncateAll(sharedDb);
  } else {
    const db = createDb(":memory:");
    await migrateDb(db, ":memory:");
    sharedDb = db;
  }
  setDb(sharedDb);
  return sharedDb;
}

export async function createTestUser(db: DB, overrides: Partial<schema.User> = {}): Promise<schema.User> {
  const id = overrides.id ?? uid("user");
  const [row] = await db
    .insert(schema.user)
    .values({
      id,
      name: overrides.name ?? "Test Taster",
      email: overrides.email ?? `${id}@example.com`,
      emailVerified: true,
    })
    .returning();
  return row;
}

export async function createTestBottle(
  db: DB,
  overrides: Partial<schema.NewBottle> = {},
): Promise<schema.Bottle> {
  const [row] = await db
    .insert(schema.bottles)
    .values({
      id: overrides.id ?? uid("bottle"),
      name: overrides.name ?? "Test Bourbon 10",
      category: overrides.category ?? "bourbon",
      abv: overrides.abv ?? 45,
      msrp: overrides.msrp ?? 49.99,
      avgPrice: overrides.avgPrice ?? 59.99,
      flavorProfile: overrides.flavorProfile ?? { sweet: 7, woody: 6, spicy: 4, fruity: 3 },
      ...overrides,
    })
    .returning();
  return row;
}

/**
 * Mock the auth seam so route handlers see `user` as signed in.
 * Usage (top of test file):
 *   vi.mock("@/lib/session", async (importOriginal) => mockSessionModule());
 * then per-test: setSessionUser(user)
 */
let currentUser: SessionUser | null = null;

export function setSessionUser(user: { id: string; name: string; email: string } | null): void {
  currentUser = user ? { id: user.id, name: user.name, email: user.email } : null;
}

export async function mockSessionModule() {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return {
    ...actual,
    getSessionUser: async () => currentUser,
    requireUser: async () => {
      if (!currentUser) throw new actual.UnauthorizedError();
      return currentUser;
    },
  };
}

/** Build a NextRequest-compatible Request for route handler tests. */
export function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql/web";
import { createClient } from "@libsql/client/web";
import * as schema from "./schema";

/**
 * Unified handle over the two SQLite drivers we run against:
 *
 *   - Production (Vercel serverless) → hosted libSQL / Turso via the pure-JS
 *     `@libsql/client/web` client. No native module enters the bundle.
 *   - Local dev + vitest → synchronous `better-sqlite3` against a file or an
 *     in-memory DB. It is lazily `require`d (never statically imported) so it
 *     never reaches the serverless bundle, and stays synchronous so test setup
 *     (setupTestDb) needs no `await`.
 *
 * Both drivers are `BaseSQLiteDatabase` subtypes, so the app code — which always
 * `await`s its queries — works against either. `<"sync" | "async">` accepts both
 * concrete driver types.
 */
export type DB = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

const nodeRequire = createRequire(import.meta.url);

/** A remote/hosted libSQL endpoint (Turso) vs. a local file / in-memory DB. */
export function isRemoteUrl(url: string): boolean {
  return /^(libsql|https?|wss?):/i.test(url);
}

function createLocalDb(url: string): DB {
  // Lazily pull in the better-sqlite3 driver so neither it nor its native
  // addon are statically imported into the Next.js serverless bundle.
  const { drizzle } = nodeRequire("drizzle-orm/better-sqlite3") as typeof import("drizzle-orm/better-sqlite3");
  const Database = nodeRequire("better-sqlite3") as typeof import("better-sqlite3");

  const file = url === ":memory:" ? ":memory:" : url.replace(/^file:/, "");
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/**
 * Build a DB handle for a connection string.
 *   - `libsql://…`, `https://…` → hosted libSQL (pass an auth token for Turso).
 *   - `:memory:`, `file:…`, or a bare path → local better-sqlite3.
 */
export function createDb(url: string, authToken?: string): DB {
  if (isRemoteUrl(url)) {
    const client = createClient({ url, authToken });
    return drizzleLibsql(client, { schema });
  }
  return createLocalDb(url);
}

const globalForDb = globalThis as unknown as { __whaikeyDb?: DB };

/** Resolve the connection string from the environment (see .env.example). */
export function resolveDbUrl(): { url: string; authToken?: string } {
  const url =
    process.env.DATABASE_URL ??
    process.env.DATABASE_PATH ?? // legacy local fallback
    path.join(process.cwd(), "data", "whaikey.db");
  return { url, authToken: process.env.DATABASE_AUTH_TOKEN };
}

export function getDb(): DB {
  if (!globalForDb.__whaikeyDb) {
    const { url, authToken } = resolveDbUrl();
    globalForDb.__whaikeyDb = createDb(url, authToken);
  }
  return globalForDb.__whaikeyDb;
}

/** Test-only: swap the singleton (used by vitest helpers). */
export function setDb(db: DB | undefined): void {
  globalForDb.__whaikeyDb = db;
}

export { schema };

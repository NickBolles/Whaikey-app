import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Unified handle over the two Postgres drivers we run against:
 *
 *   - Production (Vercel serverless) → hosted Postgres (Supabase) via
 *     `postgres` (postgres-js). Use the connection pooler URL; prepared
 *     statements are disabled for pgbouncer transaction mode.
 *   - Local dev + vitest → PGlite, an in-process WASM Postgres. No network, no
 *     native module, no server to run. `:memory:` for tests, a data dir for
 *     `pnpm dev`. PGlite is lazily `require`d (never statically imported) so
 *     its WASM payload never enters the serverless bundle.
 *
 * Both drivers are `PgDatabase` subtypes, so the app code — which always
 * `await`s its queries — works against either.
 */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const nodeRequire = createRequire(import.meta.url);

/** A hosted Postgres connection string vs. a local PGlite file / in-memory DB. */
export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}

function createLocalDb(url: string): DB {
  // Lazily pull in PGlite so its WASM bundle is never statically imported into
  // the Next.js serverless build (production never takes this branch).
  const { PGlite } = nodeRequire("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
  const { drizzle } = nodeRequire("drizzle-orm/pglite") as typeof import("drizzle-orm/pglite");

  const dataDir = url === ":memory:" ? undefined : url.replace(/^file:/, "");
  if (dataDir) {
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  }
  const client = new PGlite(dataDir);
  return drizzle(client, { schema }) as unknown as DB;
}

/**
 * Build a DB handle for a connection string.
 *   - `postgres://…` / `postgresql://…` → hosted Postgres (postgres-js).
 *   - `:memory:`, `file:…`, or a bare path → local PGlite.
 */
export function createDb(url: string): DB {
  if (isPostgresUrl(url)) {
    // `prepare: false` keeps us compatible with Supabase's transaction pooler
    // (pgbouncer); `max: 1` suits short-lived serverless invocations.
    const client = postgres(url, { prepare: false, max: 1 });
    return drizzlePostgres(client, { schema });
  }
  return createLocalDb(url);
}

const globalForDb = globalThis as unknown as { __whaikeyDb?: DB };

/** Resolve the connection string from the environment (see .env.example). */
export function resolveDbUrl(): string {
  return (
    process.env.DATABASE_URL ??
    process.env.DATABASE_PATH ?? // legacy local fallback
    path.join(process.cwd(), "data", "whaikey")
  );
}

export function getDb(): DB {
  if (!globalForDb.__whaikeyDb) {
    globalForDb.__whaikeyDb = createDb(resolveDbUrl());
  }
  return globalForDb.__whaikeyDb;
}

/** Test-only: swap the singleton (used by vitest helpers). */
export function setDb(db: DB | undefined): void {
  globalForDb.__whaikeyDb = db;
}

export { schema };

import { createRequire } from "node:module";
import fs from "node:fs";
import process from "node:process";
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

// Anchored to the working directory, not import.meta.url: Playwright's e2e
// global-setup imports this file through a CJS transpile, where `import.meta`
// is a syntax error. Resolution only needs to find the project's node_modules,
// which the cwd anchor does in every environment that reaches the PGlite branch.
const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));

/** A hosted Postgres connection string vs. a local PGlite file / in-memory DB. */
export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}

function createLocalDb(url: string): DB {
  // A local PGlite/file DB can never work on Vercel's read-only serverless
  // filesystem. If we reach this branch at runtime there, DATABASE_URL is
  // missing or isn't a `postgres://` URL — fail with a clear message instead of
  // a cryptic `ENOENT: mkdir '/var/task/data'`. (Guarded off the build phase so
  // `next build` — which may evaluate this without env vars — still succeeds.)
  if (process.env.VERCEL && process.env.NEXT_PHASE !== "phase-production-build") {
    throw new Error(
      "No Postgres DATABASE_URL is configured, but the app is running on Vercel, " +
        "where a local database cannot be used. Set DATABASE_URL to your Postgres " +
        "connection string (e.g. the Supabase transaction-pooler URL, " +
        "postgres://…pooler.supabase.com:6543/postgres) for the Production and " +
        "Preview environments, then redeploy.",
    );
  }

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

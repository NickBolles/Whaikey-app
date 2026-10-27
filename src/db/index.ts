import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { createResilientClient, poolerMode, type PgClientLike } from "./resilient-client";

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
  // Contrib modules are opt-in in PGlite: without this, the migration's
  // CREATE EXTENSION pg_trgm fails with "extension is not available", and
  // catalog search's trigram indexes and typo fallback have nothing to run on.
  const { pg_trgm } = nodeRequire(
    "@electric-sql/pglite/contrib/pg_trgm",
  ) as typeof import("@electric-sql/pglite/contrib/pg_trgm");

  const dataDir = url === ":memory:" ? undefined : url.replace(/^file:/, "");
  if (dataDir) {
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  }
  // The options-object form: `new PGlite(undefined, options)` — the in-memory
  // case — silently drops the options, extensions included.
  const client = new PGlite({ dataDir, extensions: { pg_trgm } });
  return drizzle(client, { schema }) as unknown as DB;
}

/**
 * Build a DB handle for a connection string.
 *   - `postgres://…` / `postgresql://…` → hosted Postgres (postgres-js).
 *   - `:memory:`, `file:…`, or a bare path → local PGlite.
 */
export function createDb(url: string): DB {
  if (isPostgresUrl(url)) {
    const settings = hostedDbSettings();
    // `prepare: false` keeps us compatible with Supabase's transaction pooler
    // (Supavisor, port 6543). A small pool (not 1) so one slow statement — a
    // page widget, an after() popularity write — cannot queue every other
    // request on the instance behind it. Idle sockets close after 20 s and
    // none lives past 5 min, so a connection that died while the instance
    // was frozen is not reused. See ./resilient-client.ts for the watchdog.
    //
    // No pipelining is the important part. postgres-js pipelines up to 100
    // queries on a busy connection by default, and the signed-in home fires
    // seven at once. Through Supavisor's transaction mode that left a backend
    // holding a lone PARSE (the home page's `passport_tiers` read) until
    // Supabase's 2-minute cap cancelled it (57014, command tag PARSE, 22:57Z
    // and 00:40Z on 2026-10-26/27) while the client waited for an answer that
    // never came. The resilient client caps in-flight work at the pool size,
    // so every query gets a connection of its own; `max_pipeline: 1` bounds
    // the fallback (0 would break `sql.begin`'s connection reservation). The
    // option exists at runtime (postgres@3.4 src/connection.js) but not in
    // the typings, hence the cast.
    const options = {
      prepare: false,
      max: settings.max,
      max_pipeline: 1,
      idle_timeout: 20,
      max_lifetime: 60 * 5,
      connect_timeout: 10,
      connection: { application_name: "caskfolk" },
    };
    const factory = () => postgres(url, options as postgres.Options<Record<string, never>>) as unknown as PgClientLike;
    if (process.env.VERCEL && !loggedMode) {
      loggedMode = true;
      const mode = poolerMode(url);
      // Names only, never the URL. Session mode / direct connections hold a
      // server connection per client and exhaust Supabase's small pool.
      console.info(`[db] postgres pooler mode: ${mode} (pool max ${settings.max}, query watchdog ${settings.queryTimeoutMs} ms)`);
      if (mode !== "transaction") {
        console.warn("[db] DATABASE_URL is not the Supabase transaction pooler (port 6543); serverless should use it.");
      }
    }
    const client = createResilientClient(factory, {
      queryTimeoutMs: settings.queryTimeoutMs,
      concurrency: settings.max,
      transactionTimeoutMs: settings.transactionTimeoutMs,
      graceMs: 4000,
      onEvent: (e) =>
        console.warn(`[db] ${e.kind === "cancel" ? "cancelling slow query" : "resetting stuck pool"} after ${e.elapsedMs} ms: ${e.query}`),
    });
    return drizzlePostgres(client as unknown as postgres.Sql, { schema }) as unknown as DB;
  }
  return createLocalDb(url);
}

let loggedMode = false;

/**
 * Pool size and watchdog limits. The watchdog is on by default only on Vercel
 * (a request must never outlive the platform limit); one-shot CLIs such as the
 * flavor apply run their own `SET LOCAL statement_timeout` and long scans.
 */
export function hostedDbSettings(env: Record<string, string | undefined> = process.env) {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
  };
  const onVercel = Boolean(env.VERCEL);
  return {
    max: Math.max(1, Math.min(10, num(env.DB_POOL_MAX, 4))),
    queryTimeoutMs: num(env.DB_QUERY_TIMEOUT_MS, onVercel ? 15_000 : 0),
    transactionTimeoutMs: num(env.DB_TRANSACTION_TIMEOUT_MS, onVercel ? 45_000 : 0),
  };
}

/** Hosted Postgres (postgres-js, a function) rather than PGlite (an object). */
export function isHostedDb(db: DB): boolean {
  return typeof (db as unknown as { $client?: unknown }).$client === "function";
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

/**
 * Close the underlying driver connection. Both `drizzle()` calls in this file
 * attach the raw client as `$client`; postgres-js exposes `end()`, PGlite
 * exposes `close()`. Long-lived server code never calls this (the singleton
 * outlives a request), but one-shot CLI scripts must, or the process hangs on
 * an open socket/WASM handle after `main()` resolves.
 */
export async function closeDb(db: DB): Promise<void> {
  const client = (db as unknown as { $client?: unknown }).$client;
  // postgres-js's client is the `sql` tagged-template FUNCTION, so an
  // object-only check skipped it and never closed a production connection.
  if (!client || (typeof client !== "object" && typeof client !== "function")) return;
  const closable = client as { end?: () => Promise<unknown>; close?: () => Promise<unknown> };
  if (typeof closable.end === "function") await closable.end();
  else if (typeof closable.close === "function") await closable.close();
}

export { schema };

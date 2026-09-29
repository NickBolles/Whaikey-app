import postgres from "postgres";

/**
 * The Postgres lane (review REL-8.2): the same unit/route suite, run against a
 * real Postgres server through postgres-js — the driver production uses —
 * instead of in-process PGlite. PGlite and postgres-js disagree in ways only a
 * real server shows (parameter type coercion, `execute()` result shape, Date
 * encoding — see `b5b4db0 fix: encode rate-limit timestamps for Postgres`), so
 * a green PGlite run alone cannot vouch for production.
 *
 * Opt in with `WHAIKEY_TEST_POSTGRES_URL=postgres://user:pass@host:port/db`.
 * Unset (the default, and every local `pnpm test`), nothing here runs.
 *
 * Layout: global setup migrates ONE template database per run; each test file
 * then clones it (`CREATE DATABASE … TEMPLATE`, a file copy — far cheaper
 * than replaying every migration per file) into a database named for its
 * vitest worker, so parallel workers never truncate each other's rows.
 */
export const TEST_POSTGRES_URL_ENV = "WHAIKEY_TEST_POSTGRES_URL";

const TEMPLATE_DB = "whaikey_test_template";

export function testPostgresUrl(): string | undefined {
  const url = process.env[TEST_POSTGRES_URL_ENV];
  return url && url.trim() ? url.trim() : undefined;
}

/** `url` with its database name swapped — the server and credentials stay. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function templateDatabaseUrl(url: string): string {
  return withDatabase(url, TEMPLATE_DB);
}

/** One database per vitest worker; files within a worker run one at a time. */
export function workerDatabaseName(): string {
  const id = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? String(process.pid);
  return `whaikey_test_w${id.replace(/\D/g, "") || "0"}`;
}

function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Refusing unsafe database name: ${name}`);
  return `"${name}"`;
}

/** Run admin statements (CREATE/DROP DATABASE) on the server's base database. */
async function withAdmin<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const admin = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Drop and recreate an empty database. `WITH (FORCE)` ends stale sessions. */
export async function recreateDatabase(url: string, name: string, template?: string): Promise<void> {
  await withAdmin(url, async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    await sql.unsafe(
      `CREATE DATABASE ${quoteIdent(name)}${template ? ` TEMPLATE ${quoteIdent(template)}` : ""}`,
    );
    // postgres-js prints every NOTICE (identifier truncation in migrations,
    // "truncate cascades to …" between tests) to stdout, burying real
    // failures. Per-database settings are not copied from a template, so set
    // it on each database created here.
    await sql.unsafe(`ALTER DATABASE ${quoteIdent(name)} SET client_min_messages = warning`);
  });
}

export async function createTemplateDatabase(url: string): Promise<void> {
  await recreateDatabase(url, TEMPLATE_DB);
}

/** A fresh, migrated database for this worker, cloned from the template. */
export async function cloneWorkerDatabase(url: string): Promise<string> {
  const name = workerDatabaseName();
  await recreateDatabase(url, name, TEMPLATE_DB);
  return withDatabase(url, name);
}

/** Drop every database this lane created (template + per-worker clones). */
export async function dropTestDatabases(url: string): Promise<void> {
  await withAdmin(url, async (sql) => {
    const rows = await sql<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname LIKE 'whaikey\_test\_%'
    `;
    for (const { datname } of rows) {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(datname)} WITH (FORCE)`);
    }
  });
}

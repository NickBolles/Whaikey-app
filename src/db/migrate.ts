import { createRequire } from "node:module";
import path from "node:path";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import { createDb, isRemoteUrl, resolveDbUrl, type DB } from "./index";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "src", "db", "migrations");
const nodeRequire = createRequire(import.meta.url);

function migrateBetterSqlite(db: DB): void {
  const { migrate } = nodeRequire(
    "drizzle-orm/better-sqlite3/migrator",
  ) as typeof import("drizzle-orm/better-sqlite3/migrator");
  migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Synchronous migrate for the local better-sqlite3 path (vitest, local dev).
 * Kept sync so setupTestDb() needs no `await`.
 */
export function migrateDb(db: DB): void {
  migrateBetterSqlite(db);
}

/** Migrate whichever driver `db` is — async so it works against remote libSQL. */
export async function migrateAny(db: DB, url: string): Promise<void> {
  if (isRemoteUrl(url)) {
    await migrateLibsql(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    migrateBetterSqlite(db);
  }
}

// CLI entry: `pnpm db:push` (tsx src/db/migrate.ts). Runs against DATABASE_URL,
// so it migrates the remote (Turso) DB in prod or the local file in dev.
if (process.argv[1]?.endsWith("migrate.ts")) {
  const { url, authToken } = resolveDbUrl();
  const db = createDb(url, authToken);
  migrateAny(db, url)
    .then(() => console.log(`Migrated ${url}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

import { createRequire } from "node:module";
import path from "node:path";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { createDb, isPostgresUrl, resolveDbUrl, type DB } from "./index";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "src", "db", "migrations");
const nodeRequire = createRequire(import.meta.url);

/**
 * Apply migrations against whichever driver `db` is — postgres-js in
 * production, PGlite locally / in tests. Both migrators are async.
 */
export async function migrateDb(db: DB, url: string): Promise<void> {
  if (isPostgresUrl(url)) {
    await migratePostgres(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    // Lazy-require so PGlite's migrator never enters the serverless bundle.
    const { migrate } = nodeRequire(
      "drizzle-orm/pglite/migrator",
    ) as typeof import("drizzle-orm/pglite/migrator");
    await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  }
}

// CLI entry: `pnpm db:push` (tsx src/db/migrate.ts). Runs against DATABASE_URL,
// so it migrates the remote (Supabase) DB in prod or the local PGlite dir in dev.
if (process.argv[1]?.endsWith("migrate.ts")) {
  const url = resolveDbUrl();
  const db = createDb(url);
  migrateDb(db, url)
    .then(() => {
      console.log(`Migrated ${url}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

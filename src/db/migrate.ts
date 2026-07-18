import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { createDb, type DB } from "./index";

const MIGRATIONS_FOLDER = path.join(process.cwd(), "src", "db", "migrations");

export function migrateDb(db: DB): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "whaikey.db");
  const db = createDb(dbPath);
  migrateDb(db);
  console.log(`Migrated ${dbPath}`);
}

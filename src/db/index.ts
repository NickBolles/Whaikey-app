import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

export function createDb(dbPath: string): DB {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

const globalForDb = globalThis as unknown as { __whaikeyDb?: DB };

export function getDb(): DB {
  if (!globalForDb.__whaikeyDb) {
    const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "whaikey.db");
    globalForDb.__whaikeyDb = createDb(dbPath);
  }
  return globalForDb.__whaikeyDb;
}

/** Test-only: swap the singleton (used by vitest helpers). */
export function setDb(db: DB | undefined): void {
  globalForDb.__whaikeyDb = db;
}

export { schema };

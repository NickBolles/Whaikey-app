import { closeDb, createDb } from "@/db";
import { migrateDb } from "@/db/migrate";
import {
  createTemplateDatabase,
  dropTestDatabases,
  templateDatabaseUrl,
  testPostgresUrl,
} from "./postgres";

/**
 * Vitest global setup for the Postgres lane (see ./postgres.ts). Registered
 * only when WHAIKEY_TEST_POSTGRES_URL is set.
 *
 * Migrating the template here is itself a test: it is the one place the
 * committed migrations are applied by the postgres-js migrator — the path
 * `pnpm db:push` takes in production — rather than PGlite's.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const url = testPostgresUrl();
  if (!url) throw new Error("postgres-global-setup registered without WHAIKEY_TEST_POSTGRES_URL");

  await dropTestDatabases(url);
  await createTemplateDatabase(url);
  const templateUrl = templateDatabaseUrl(url);
  const db = createDb(templateUrl);
  try {
    await migrateDb(db, templateUrl);
  } finally {
    // CREATE DATABASE … TEMPLATE refuses while anyone is connected to it.
    await closeDb(db);
  }

  return async () => {
    await dropTestDatabases(url);
  };
}

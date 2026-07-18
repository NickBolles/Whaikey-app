import path from "node:path";
import fs from "node:fs";

/** Fresh, seeded SQLite DB for the e2e web server before tests run. */
export default async function globalSetup() {
  const dbPath = path.join(process.cwd(), process.env.PW_DB_PATH ?? "data/e2e.db");
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });

  const { createDb } = await import("../src/db/index");
  const { migrateDb } = await import("../src/db/migrate");
  const { seedDatabase } = await import("../src/db/seed/index");
  const { seedDemoUser } = await import("./demo-seed");

  const db = createDb(dbPath);
  migrateDb(db);
  await seedDatabase(db);
  await seedDemoUser(db);
}

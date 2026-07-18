import path from "node:path";
import fs from "node:fs";

/** Fresh, seeded local Postgres (PGlite) DB for the e2e web server before tests run. */
export default async function globalSetup() {
  const dbDir = path.join(process.cwd(), process.env.PW_DB_PATH ?? "data/e2e.db");
  fs.rmSync(dbDir, { recursive: true, force: true });

  const { createDb } = await import("../src/db/index");
  const { migrateDb } = await import("../src/db/migrate");
  const { seedDatabase } = await import("../src/db/seed/index");
  const { seedDemoUser } = await import("./demo-seed");

  const db = createDb(dbDir);
  await migrateDb(db, dbDir);
  await seedDatabase(db);
  await seedDemoUser(db);
}

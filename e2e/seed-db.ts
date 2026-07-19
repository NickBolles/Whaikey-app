/**
 * Standalone e2e DB bootstrap, run via tsx as a subprocess from global-setup.
 *
 * It lives in its own process (not imported into Playwright's global-setup)
 * because the app DB modules use `import.meta.url` (createRequire for lazy
 * PGlite loading). Playwright's own TypeScript transform hands a dynamically
 * or statically imported .ts file to Node's native loader, which then chokes on
 * `import.meta` — so we run this under tsx, which handles ESM + import.meta
 * natively, exactly like the project's `db:push` / `db:seed` scripts do.
 *
 * Reads the target DB path from PW_DB_PATH (set by playwright.config.ts).
 */
import { createDb } from "../src/db/index";
import { migrateDb } from "../src/db/migrate";
import { seedDatabase } from "../src/db/seed/index";
import { seedDemoUser } from "./demo-seed";

async function main() {
  const dbDir = process.env.PW_DB_PATH ?? "data/e2e.db";
  const db = createDb(dbDir);
  await migrateDb(db, dbDir);
  await seedDatabase(db);
  await seedDemoUser(db);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

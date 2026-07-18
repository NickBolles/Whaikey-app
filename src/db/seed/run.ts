/** CLI entry: pnpm db:seed (tsx src/db/seed/run.ts). */
import { createDb } from "../index";
import { migrateDb } from "../migrate";
import { seedDatabase } from "./index";

async function main(): Promise<void> {
  const dbPath = process.env.DATABASE_PATH ?? "./data/whaikey.db";
  const db = createDb(dbPath);
  migrateDb(db);
  const counts = await seedDatabase(db);
  console.log(
    `Seeded ${dbPath}: ${counts.distilleries} distilleries, ${counts.bottles} bottles, ${counts.aliases} aliases`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

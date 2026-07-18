/** CLI entry: pnpm db:seed (tsx src/db/seed/run.ts). Runs against DATABASE_URL. */
import { createDb, resolveDbUrl } from "../index";
import { migrateAny } from "../migrate";
import { seedDatabase } from "./index";

async function main(): Promise<void> {
  const { url, authToken } = resolveDbUrl();
  const db = createDb(url, authToken);
  await migrateAny(db, url);
  const counts = await seedDatabase(db);
  console.log(
    `Seeded ${url}: ${counts.distilleries} distilleries, ${counts.bottles} bottles, ${counts.aliases} aliases`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

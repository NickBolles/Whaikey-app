/** CLI entry: pnpm db:seed (tsx src/db/seed/run.ts). Runs against DATABASE_URL. */
import { createDb, resolveDbUrl } from "../index";
import { migrateDb } from "../migrate";
import { describeDbUrl, formatDbError } from "../redact";
import { seedDatabase } from "./index";

async function main(): Promise<void> {
  const url = resolveDbUrl();
  const db = createDb(url);
  await migrateDb(db, url);
  const counts = await seedDatabase(db);
  console.log(
    `Seeded ${describeDbUrl(url)}: ${counts.distilleries} distilleries, ${counts.bottles} bottles, ${counts.aliases} aliases`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(formatDbError(err, process.env.DATABASE_URL));
    process.exit(1);
  });

// `pnpm test:postgres` — the unit/route suite against a real Postgres server
// (review REL-8.2; src/test/postgres.ts has the mechanics). CI runs this
// against a postgres service container; locally, point it at any server you
// can create databases on:
//
//   docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
//   WHAIKEY_TEST_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test:postgres
//
// It creates and drops databases named `whaikey_test_*` on that server and
// touches nothing else — but never point it at a database you care about.
import { spawnSync } from "node:child_process";

const url = process.env.WHAIKEY_TEST_POSTGRES_URL?.trim();
if (!url) {
  console.error(
    "WHAIKEY_TEST_POSTGRES_URL is not set. Point it at a Postgres server this suite may\n" +
      "create and drop `whaikey_test_*` databases on, e.g.\n" +
      "  WHAIKEY_TEST_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test:postgres",
  );
  process.exit(2);
}

const result = spawnSync("pnpm", ["exec", "vitest", "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);

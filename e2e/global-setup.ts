import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Fresh, seeded local Postgres (PGlite) DB for the e2e web server before tests
 * run. The actual migrate+seed happens in e2e/seed-db.ts, run as a tsx
 * subprocess: the app DB modules use import.meta.url, which Playwright's
 * TypeScript transform can't load through Node's require path (it crashes with
 * "Cannot use 'import.meta' outside a module"). tsx handles it natively, and
 * this global-setup module itself imports only Node builtins so it transforms
 * cleanly.
 */
export default async function globalSetup() {
  const dbDir = path.join(process.cwd(), process.env.PW_DB_PATH ?? "data/e2e.db");
  fs.rmSync(dbDir, { recursive: true, force: true });

  const seedScript = path.join(process.cwd(), "e2e", "seed-db.ts");
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");

  execFileSync(tsxBin, [seedScript], {
    stdio: "inherit",
    env: { ...process.env, PW_DB_PATH: dbDir },
  });
}

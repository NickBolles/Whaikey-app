// Vercel/CI build entry. On Vercel *production* deploys, apply any pending
// database migrations AFTER the build succeeds and before the deploy is
// promoted, so the schema never lags behind the deployed code (which otherwise
// 500s with "column … does not exist").
//
// Gated on VERCEL_ENV === "production":
//   - Preview deploys skip it, so they never mutate the production database.
//   - Local `pnpm build` and CI skip it (VERCEL_ENV is unset).
//
// Order matters (review REL-8.6). Migrating first meant a build that then
// failed left the schema ahead of the release still serving traffic, with no
// new code coming to use it. Now:
//   - build fails   → nothing touched the database; the old release keeps
//                     serving against the schema it was built for.
//   - migrate fails → this script exits non-zero, Vercel does not promote the
//                     build, and the migrator's transaction rolls the batch
//                     back, so the old release again sees its own schema.
//   - both succeed  → Vercel promotes. The previous release still serves
//                     traffic against the NEW schema until promotion
//                     completes, so every migration must stay backward
//                     compatible with the release before it: expand/contract.
//                     Add columns/tables first; drop or rename only in a
//                     later deploy, once no serving release reads them (see
//                     docs/REVIEW_2026-09.md SEC-H2's `used_at` for a worked
//                     example).
import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

run("pnpm exec next build");

if (process.env.VERCEL_ENV === "production") {
  console.log("▲ Production deploy — build succeeded; applying database migrations (pnpm db:push)…");
  run("pnpm db:push");
}

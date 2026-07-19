// Vercel/CI build entry. On Vercel *production* deploys, apply any pending
// database migrations before building, so the schema never lags behind the
// deployed code (which otherwise 500s with "column … does not exist").
//
// Gated on VERCEL_ENV === "production":
//   - Preview deploys skip it, so they never mutate the production database.
//   - Local `pnpm build` and CI skip it (VERCEL_ENV is unset).
import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

if (process.env.VERCEL_ENV === "production") {
  console.log("▲ Production deploy — applying database migrations (pnpm db:push)…");
  run("pnpm db:push");
}

run("pnpm exec next build");

import { defineConfig } from "@playwright/test";

// Override for parallel isolated runs (each port gets its own seeded DB).
const PORT = Number(process.env.PW_PORT ?? 3111);
const DB_PATH = `./data/e2e-${PORT}.db`;
process.env.PW_DB_PATH = DB_PATH;

// CI serves the PRODUCTION build (`next build` + `next start`); local runs keep
// `next dev` for its fast edit loop. Two reasons, both learned the hard way:
//   - `next dev` compiles each route on first visit, and under Next 16.3.7 the
//     server keeps that memory — the suite took it past 13 GB and the runner
//     killed it mid-run (WP-26). A built server compiles nothing.
//   - On-demand compiles were also the source of the cold-start flakes that
//     used to hide behind an unconditional retry (review REL-8.5).
// It also tests what ships: the production CSP, without dev's `unsafe-eval`.
// PW_DEV_SERVER=1 forces `next dev` in CI; PW_PROD_SERVER=1 forces a build locally.
const PROD_SERVER =
  process.env.PW_PROD_SERVER === "1" || (!!process.env.CI && process.env.PW_DEV_SERVER !== "1");

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  // One retry in CI only (review REL-8.5). Locally a flake must fail loudly —
  // a retry there is how a real intermittent bug gets learned to be ignored.
  // In CI a test that passes only on its retry is still reported: the
  // `github` reporter annotates it as flaky on the PR, so a retry absorbs a
  // runner hiccup without hiding the test that needed one.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : "list",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      // Tolerate sub-pixel AA differences, fail on real layout/style drift.
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : undefined,
  },
  projects: [
    {
      name: "functional",
      testMatch: /(smoke|social)\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: "visual-mobile",
      testMatch: /visual\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 },
    },
    {
      name: "visual-desktop",
      testMatch: /visual\.spec\.ts/,
      use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
  ],
  webServer: {
    command: PROD_SERVER
      ? `pnpm exec next build && pnpm exec next start --port ${PORT}`
      : `pnpm dev --port ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_PATH: DB_PATH,
      BETTER_AUTH_SECRET: "e2e-secret",
      // Better Auth refuses state-changing calls from an origin other than its
      // base URL ("Invalid origin"), and the default is :3000 — so without
      // this, sign-out from the browser was refused on every PW_PORT and the
      // Settings smoke (WP-11) caught it. Production sets its own.
      BETTER_AUTH_URL: `http://localhost:${PORT}`,
      NEXT_PUBLIC_OAUTH_CONFIGURED: "false",
      // Keep scan-miss behavior deterministic: never call external UPC APIs.
      WHAIKEY_UPC_LOOKUP: "off",
      // Server-side clock pin, matching the browser's page.clock fixed time in
      // visual.spec.ts — the dashboard's month-in-review is computed on the
      // server, where the browser pin can't reach (src/lib/clock.ts).
      WHAIKEY_FAKE_NOW: "2026-07-19T19:30:00Z",
      // The CSP goes to production report-only (review SEC-H3), but it is only
      // worth shipping if it holds — so e2e runs it ENFORCED. A directive this
      // app actually needs shows up here as a broken page, not as a report
      // nobody read.
      WHAIKEY_CSP_ENFORCE: "true",
      // One account is on the moderation allowlist (PLAN.md §9.4), so the e2e
      // suite can walk both sides of it: a queue for the operator, a 404 for
      // everybody else. Left UNSET would only ever prove the 404.
      WHAIKEY_OPERATOR_IDS: "operator-user",
    },
    // A production build takes a couple of minutes on a CI runner.
    timeout: PROD_SERVER ? 360_000 : 120_000,
  },
});

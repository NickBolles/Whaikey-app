import { defineConfig } from "@playwright/test";

// Override for parallel isolated runs (each port gets its own seeded DB).
const PORT = Number(process.env.PW_PORT ?? 3111);
const DB_PATH = `./data/e2e-${PORT}.db`;
process.env.PW_DB_PATH = DB_PATH;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  retries: 1,
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
    command: `pnpm dev --port ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_PATH: DB_PATH,
      BETTER_AUTH_SECRET: "e2e-secret",
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
    timeout: 120_000,
  },
});

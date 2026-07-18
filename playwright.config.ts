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
      testMatch: /smoke\.spec\.ts/,
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
    },
    timeout: 120_000,
  },
});

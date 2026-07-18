import { defineConfig } from "@playwright/test";

const PORT = 3111;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : undefined,
  },
  webServer: {
    command: `pnpm dev --port ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_PATH: "./data/e2e.db",
      BETTER_AUTH_SECRET: "e2e-secret",
      NEXT_PUBLIC_OAUTH_CONFIGURED: "false",
    },
    timeout: 120_000,
  },
});

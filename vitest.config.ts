import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The Postgres lane (review REL-8.2, src/test/postgres.ts): set
// WHAIKEY_TEST_POSTGRES_URL and the same suite runs against a real Postgres
// server through postgres-js instead of in-process PGlite.
const postgresLane = Boolean(process.env.WHAIKEY_TEST_POSTGRES_URL?.trim());

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    // Node by default; component tests opt into jsdom with a
    // `// @vitest-environment jsdom` docblock at the top of the file.
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    globalSetup: postgresLane ? ["./src/test/postgres-global-setup.ts"] : [],
    include: ["src/**/*.test.{ts,tsx}"],
    pool: "forks",
    // Each worker boots its own PGlite (WASM Postgres) and migrates it. When
    // many workers migrate at once the CPU thrashes and a booting instance can
    // take well over the default 10s hook timeout — capping worker count keeps
    // that contention bounded, and the wider timeouts absorb the remaining
    // load spikes (a genuine hang still fails, just later).
    maxWorkers: 6,
    testTimeout: 30000,
    hookTimeout: 30000,
    // `pnpm test:coverage` (what CI runs). The thresholds are a FLOOR, set a
    // point under what the suite measured when they were introduced (review
    // REL-8.7, WP-26: 78.1% statements / 71.0% branches / 76.6% functions /
    // 80.4% lines) — a ratchet against untested code landing, not a target.
    // Raise them when coverage rises; never lower them to get a PR green.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/db/migrations/**"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { statements: 77, branches: 70, functions: 75, lines: 79 },
    },
  },
});

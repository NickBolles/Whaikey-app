import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

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
  },
});

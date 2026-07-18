import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the dev-tools badge out of visual regression screenshots.
  devIndicators: false,
  // Keep the DB drivers external (loaded via native require, not bundled):
  // postgres-js is server-only, and PGlite's WASM payload (local dev / tests)
  // must never enter the serverless bundle.
  serverExternalPackages: ["postgres", "@electric-sql/pglite"],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the dev-tools badge out of visual regression screenshots.
  devIndicators: false,
  // Keep the SQLite drivers out of the server bundle and loaded via native
  // require. better-sqlite3 (local dev / tests) must never be bundled; the
  // libSQL client is server-only too. Both are on Next's auto-external list,
  // but we pin them here so the intent is explicit and stable.
  serverExternalPackages: ["better-sqlite3", "@libsql/client"],
};

export default nextConfig;

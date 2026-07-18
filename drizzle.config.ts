import { defineConfig } from "drizzle-kit";

// Postgres in every environment: Supabase in production, PGlite (in-process
// WASM Postgres) locally and in tests. Applying migrations to the remote DB is
// handled by our own scripts — `pnpm db:push` (src/db/migrate.ts) and
// `pnpm db:seed` — which read DATABASE_URL. drizzle-kit here is only used for
// `pnpm db:generate` (schema diff → SQL), which needs no live connection.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/whaikey",
  },
});

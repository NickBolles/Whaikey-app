import { defineConfig } from "drizzle-kit";

// Migrations stay plain SQLite (the schema is driver-agnostic and libSQL/Turso
// runs the same SQL). Applying them to the remote DB is handled by our own
// scripts — `pnpm db:push` (src/db/migrate.ts) and `pnpm db:seed` — which read
// DATABASE_URL / DATABASE_AUTH_TOKEN. drizzle-kit here is only used for
// `pnpm db:generate` (schema diff → SQL), which needs no live connection.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? process.env.DATABASE_PATH ?? "file:./data/whaikey.db",
  },
});

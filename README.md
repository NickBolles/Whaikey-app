# Whaikey 🥃

An AI-native whiskey tracking app — think Vivino/InVintory, but for whiskey, with an AI concierge built in from day one.

**Core ideas:** scan or search a bottle → decide *own / tried / wishlist* → log pours with ratings and flavor-wheel notes → track spend and collection value → get explainable pairing and new-bottle recommendations → ask the AI chat anything about whiskey or your own bar.

## Docs

- 📋 **[PLAN.md](./PLAN.md)** — vision, feature brainstorm, architecture, data model, monetization, phased roadmap.
- 🗺️ **[docs/FEATURES.md](./docs/FEATURES.md)** — detailed feature map: ~60 features with priorities, UX flows, and the build-order dependency graph.
- ⚔️ **[docs/COMPETITORS.md](./docs/COMPETITORS.md)** — competitor & market analysis (whiskey + wine apps), comparison matrix, gaps, and the decisions it feeds back into the plan.
- 🗄️ **[docs/DATA_SOURCES.md](./docs/DATA_SOURCES.md)** — data sourcing strategy: bottle catalog, barcodes, prices/valuation, label scanning, costs, and legal checklist.

## Stack

Next.js (App Router, TypeScript, Tailwind) · Drizzle ORM + SQLite (Postgres-swappable) · [Better Auth](https://better-auth.com) (social login only) · Anthropic Claude (server-side AI gateway) · Vitest + Playwright.

## Development

```bash
pnpm install
pnpm db:push      # create local SQLite schema
pnpm db:seed      # seed the bottle catalog
pnpm dev          # http://localhost:3000
pnpm test         # vitest suite
```

Copy `.env.example` to `.env.local`. Auth is social-login-only: set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (and optionally Apple). AI features need `ANTHROPIC_API_KEY`.

## Status

MVP in progress — Phases 0–2 of [PLAN.md](./PLAN.md) (core loop + AI layer).

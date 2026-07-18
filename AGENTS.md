<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Whaikey — Agent Guidelines

AI-native whiskey tracking app: search/scan bottles → own/tried/wishlist → log pours with ratings + flavor-wheel notes → $ tracking → AI concierge over the user's own data.

## Docs index (read what the task touches)

- `PLAN.md` — product plan, architecture, data model, monetization, roadmap phases.
- `docs/FEATURES.md` — feature specs with priorities; `docs/COMPETITORS.md` — market analysis; `docs/DATA_SOURCES.md` — catalog/price/scan data strategy.
- `docs/DESIGN.md` — **binding** design system (recipes + rules + screenshot workflow). Any UI change must follow it.

## Stack & commands

Next.js App Router (TS, Tailwind v4) · Drizzle + better-sqlite3 (local file DB) · Better Auth (**social login only — never add password auth**) · Anthropic SDK (server-side only) · Vitest · Playwright.

```bash
pnpm dev                 # http://localhost:3000 (needs pnpm db:push && pnpm db:seed once)
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # must ALL pass before pushing
pnpm e2e                 # functional Playwright smoke
pnpm e2e:visual          # visual regression vs committed baselines
pnpm e2e:update          # regenerate baselines after INTENTIONAL design changes
```

Playwright in this dev container: prefix with `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (adjust to the installed version). Parallel/e2e runs: set `PW_PORT=<unique>` per run — each port gets its own dev server + seeded DB. Next allows ONE dev server per tree (`.next/dev/lock`); kill stale servers rather than waiting.

## Architecture seams (use these; don't go around them)

- **DB**: `getDb()` from `src/db/index.ts`; schema in `src/db/schema.ts`; migrations generated via `pnpm db:generate` (never hand-edit `src/db/migrations/`). Tests swap the singleton via `setupTestDb()`.
- **Auth**: `getSessionUser()` / `requireUser()` / `withErrorHandling()` from `src/lib/session.ts` — the ONLY auth entry for app code; tests mock it with `mockSessionModule()` + `setSessionUser()` from `src/test/helpers.ts`.
- **AI**: all Anthropic calls server-side through `src/lib/ai/client.ts` (`getAnthropic()` + `setAnthropicForTests()`); scripted fakes in `src/lib/ai/testing.ts`. Missing `ANTHROPIC_API_KEY` ⇒ routes return 503 and UI shows a setup card — AI failures must never block the manual core loop.
- **Flavor taxonomy**: `src/lib/flavor-wheel.ts` is the shared contract (8 wedge ids, ~55 leaf ids) used by bottles.flavorProfile, tastingNotes.flavorTags, the wheel UI, and AI extraction. Do not rename ids.

## Conventions

- API routes: zod-validate input (400 with details), `requireUser()` for user data (401), 404 for missing/foreign-owned rows. Next 16: `await ctx.params` in route handlers.
- Every feature ships with tests (route tests against in-memory DB, component tests with `// @vitest-environment jsdom` + explicit `afterEach(cleanup)`), and visual baselines for changed screens (see docs/DESIGN.md workflow — regenerate, LOOK at the PNG, iterate, commit the baseline with the change).
- Deterministic visual data lives in `e2e/demo-seed.ts` (fixed ids/timestamps); signed-in test states use minted session cookies from `e2e/fixtures.ts` — never add OAuth to tests or a password backdoor to the app.
- Multi-agent work: partition by file ownership (one vertical = one agent); shared contracts (schema, taxonomy, API shapes) are defined up front and never edited concurrently.

## Product guardrails

- Responsible-drinking stance: no features/copy that reward consumption frequency; AI never encourages drinking, never invents prices or availability.
- Users' notes/inventory are private by default and always exportable; no dark patterns.
- Prices/valuations are estimates — show ranges/trends, never false precision (see COMPETITORS.md §2.7 for why).

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Whaikey — Agent Guidelines

AI-native whiskey tracking app: search/scan bottles → own/tried/wishlist → log pours with ratings + flavor-wheel notes → $ tracking → AI concierge over the user's own data.

## Docs index (read what the task touches)

- `PLAN.md` — product plan: vision, **current state (§2 — read before writing code)**, the v1 done line, architecture, roadmap tracks, monetization, compliance/ops, decisions.
- `docs/STORYBOARD.md` — **binding** target information architecture and screen boards (nav, per-screen "not here" lists, tap-count targets, global patterns). Any screen or nav change must match it or change it first.
- `docs/REVIEW_2026-09.md` — the September 2026 review: security, correctness, UX findings with file:line refs and the prioritized work packages (WP-1…26) to pick up.
- `docs/FEATURES.md` — feature specs with priorities; `docs/COMPETITORS.md` — market analysis; `docs/DATA_SOURCES.md` — catalog/price/scan data strategy.
- `docs/SOCIAL.md` — **binding** for anything social: friends/feed/clubs, the visibility model (private by default, money data never crosses a social boundary), the banned-mechanics list (no streaks, volume/ABV badges, or consumption leaderboards) **and §3.2's encouraged substitutes, which are just as binding**. Read it before adding any user-to-user surface.
- `docs/DESIGN.md` — **binding** design system (recipes + rules + screenshot workflow). Any UI change must follow it.
- `docs/NATIVE_APP.md` — iOS/Android via Capacitor: framework decision, architecture, phases, native capability catalog; `docs/APP_STORE_SETUP.md` — store onboarding runbook.

## Stack & commands

Next.js App Router (TS, Tailwind v4) · Drizzle + PGlite locally/tests and Postgres in production · Better Auth (**social login only — never add password auth**) · Anthropic Messages API via `src/lib/ai/client.ts` (OpenRouter preferred when `OPENROUTER_API_KEY` is set, Anthropic direct otherwise; server-side only) · Vitest · Playwright.

```bash
pnpm dev                 # http://localhost:3000 (needs pnpm db:push && pnpm db:seed once)
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # must ALL pass before pushing
pnpm e2e                 # functional Playwright smoke
pnpm e2e:visual          # visual regression vs committed baselines
pnpm e2e:update          # regenerate baselines after INTENTIONAL design changes
pnpm native:check        # validate the Capacitor config (runs in CI)
pnpm native:sync         # bake CAP_SERVER_URL into the offline shell + cap sync
pnpm native:assets       # render native/assets/*.svg → app icons, splash, PWA icons
```

Playwright in this dev container: prefix with `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (adjust to the installed version). Parallel/e2e runs: set `PW_PORT=<unique>` per run — each port gets its own dev server + seeded DB. Next allows ONE dev server per tree (`.next/dev/lock`); kill stale servers rather than waiting.

## Architecture seams (use these; don't go around them)

- **DB**: `getDb()` from `src/db/index.ts`; schema in `src/db/schema.ts`; migrations generated via `pnpm db:generate` (never hand-edit `src/db/migrations/`). Tests swap the singleton via `setupTestDb()`.
- **Auth**: `getSessionUser()` / `requireUser()` / `withErrorHandling()` from `src/lib/session.ts` — the ONLY auth entry for app code; tests mock it with `mockSessionModule()` + `setSessionUser()` from `src/test/helpers.ts`.
- **AI**: all Anthropic calls server-side through `src/lib/ai/client.ts` (`getAnthropic()` + `setAnthropicForTests()`); scripted fakes in `src/lib/ai/testing.ts`. Missing `ANTHROPIC_API_KEY` ⇒ routes return 503 and UI shows a setup card — AI failures must never block the manual core loop.
- **Native**: every Capacitor plugin is reached through `src/lib/native/*` (`isNativeApp()`, `loadPlugin()`), never imported directly from `src/app` or `src/components`. Each capability has a web fallback, so features are written once; the native shell loads the deployed site over HTTPS rather than a static export, so server components and cookie auth are unchanged.
- **Native sign-in**: OAuth cannot run in a WebView, so the device flow is system browser → one-time code → `/api/auth/native/exchange` (`src/lib/native-auth.ts`). Codes are single-use, 60s, stored hashed — treat them as session-equivalent credentials.
- **Flavor taxonomy**: `src/lib/flavor-wheel.ts` is the shared contract (8 wedge ids, ~55 leaf ids) used by bottles.flavorProfile, tastingNotes.flavorTags, the wheel UI, and AI extraction. Do not rename ids.

## Conventions

- API routes: zod-validate input (400 with details), `requireUser()` for user data (401), 404 for missing/foreign-owned rows. Next 16: `await ctx.params` in route handlers.
- Every feature ships with tests (route tests against in-memory DB, component tests with `// @vitest-environment jsdom` + explicit `afterEach(cleanup)`), and visual baselines for changed screens (see docs/DESIGN.md workflow — regenerate, LOOK at the PNG, iterate, commit the baseline with the change).
- Deterministic visual data lives in `e2e/demo-seed.ts` (fixed ids/timestamps); signed-in test states use minted session cookies from `e2e/fixtures.ts` — never add OAuth to tests or a password backdoor to the app.
- Multi-agent work: partition by file ownership (one vertical = one agent); shared contracts (schema, taxonomy, API shapes) are defined up front and never edited concurrently.

## Product guardrails

- The product is five verbs: **explore, learn, track, refine, share** (PLAN.md §1). Judge a feature against those before anything else — and note that the first and last are the ones this codebase has historically under-built.
- Responsible-drinking stance: no features/copy that reward consumption frequency; AI never encourages drinking, never invents prices or availability. Socially this hardens into a ban list — no streaks, no volume/ABV/time-of-day badges, no leaderboard sorted by a consumption quantity, no pour-nudging notifications (docs/SOCIAL.md §3.1).
- **The stance bans an axis, not fun.** Badges, maps, completions, passports, rivalry with friends, shareable cards — all explicitly encouraged (docs/SOCIAL.md §3.2, spec'd in docs/FEATURES.md §11). What they may count is **distinct things met** — regions, countries, distilleries, cask types, descriptors, and distilleries *visited* — never how much or how often. Breadth saturates where volume doesn't, so a 15 ml sample of something new counts the same as a bottle and a repeat pour counts for nothing. The test before building any game mechanic: **can someone win this by drinking less of more?** If yes, build it; do not stop to ask whether gamification is allowed.
- Users' notes/inventory are private by default and always exportable; no dark patterns. Visibility is opt-in per object and never raised retroactively; purchase price, collection value and spend never appear in a social projection.
- Prices/valuations are estimates — show ranges/trends, never false precision (see COMPETITORS.md §2.7 for why).

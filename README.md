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

### Testing

| Command | What it runs |
| --- | --- |
| `pnpm test` | Vitest unit suite |
| `pnpm e2e` | Playwright functional smoke suite (project `functional`) |
| `pnpm e2e:visual` | Visual regression (projects `visual-mobile` + `visual-desktop`) against the committed baselines in `e2e/__screenshots__/` |
| `pnpm e2e:update` | Re-render the visual baselines locally — **for review only** (see below) |
| `pnpm e2e:update:ci` | Re-render the visual baselines inside the CI Playwright container (Docker required) — the canonical baselines |

The web server, port (`PW_PORT`, default `3111`), and a freshly migrated + seeded SQLite DB are all managed by `playwright.config.ts` / `e2e/global-setup.ts`. Signed-in tests mint a Better Auth session cookie, so no OAuth is needed.

### CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, in three parallel jobs:

- **typecheck / lint / unit / build** — on the plain runner.
- **e2e (functional)** — `pnpm e2e`, inside the pinned `mcr.microsoft.com/playwright:<version>` container.
- **visual regression** — `pnpm e2e:visual`, in the same container.

The Playwright jobs run inside the container image that matches `@playwright/test` in `package.json` so the browser and OS-level font rendering are identical to the committed baselines. On failure, `playwright-report/` and `test-results/` (including visual diffs) are uploaded as artifacts with a 7-day retention, so you can review the pixel diffs straight from the PR's **Checks** tab.

### Visual baselines

Font rasterization differs across environments, so a baseline rendered on your laptop or in the dev container will **not** match one rendered on a GitHub runner. To keep visual regression stable, the committed baselines under `e2e/__screenshots__/` are **CI-canonical**: they must be produced by the same container CI uses.

- **Iterating on UI locally:** run `pnpm e2e:update` and open the PNGs to review your change. These local renders are for review only — do not commit them as the source of truth.
- **Updating the committed baselines:** run `pnpm e2e:update:ci` (needs Docker; it renders inside the CI Playwright container), review the regenerated PNGs, and commit them. Keep the image tag in `scripts/e2e-update-ci.sh` in sync with `@playwright/test` whenever you bump Playwright.

## Status

MVP in progress — Phases 0–2 of [PLAN.md](./PLAN.md) (core loop + AI layer).

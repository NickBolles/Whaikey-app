# Whaikey 🥃

An AI-native whiskey tracking app — think Vivino/InVintory, but for whiskey, with an AI concierge built in from day one.

**Core ideas:** scan or search a bottle → decide *own / tried / wishlist* → log pours with ratings and flavor-wheel notes → track spend and collection value → get explainable pairing and new-bottle recommendations → ask the AI chat anything about whiskey or your own bar.

## Docs

- 📋 **[PLAN.md](./PLAN.md)** — vision, feature brainstorm, architecture, data model, monetization, phased roadmap.
- 🗺️ **[docs/FEATURES.md](./docs/FEATURES.md)** — detailed feature map: ~60 features with priorities, UX flows, and the build-order dependency graph.
- ⚔️ **[docs/COMPETITORS.md](./docs/COMPETITORS.md)** — competitor & market analysis (whiskey + wine apps), comparison matrix, gaps, and the decisions it feeds back into the plan.
- 🗄️ **[docs/DATA_SOURCES.md](./docs/DATA_SOURCES.md)** — data sourcing strategy: bottle catalog, barcodes, prices/valuation, label scanning, costs, and legal checklist.

## Stack

Next.js (App Router, TypeScript, Tailwind) · Drizzle ORM + Postgres — [Supabase](https://supabase.com) in production, [PGlite](https://pglite.dev) (in-process WASM Postgres) locally and in tests · [Better Auth](https://better-auth.com) (social login only) · Anthropic Claude (server-side AI gateway) · Vitest + Playwright · deployed on Vercel.

## Development

```bash
pnpm install
pnpm db:push      # create local SQLite schema
pnpm db:seed      # seed the bottle catalog
pnpm dev          # http://localhost:3000
pnpm test         # vitest suite
```

Copy `.env.example` to `.env.local`. Auth is social-login-only: set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (and optionally Apple). AI features need `ANTHROPIC_API_KEY`.

Local dev and the test suite run on [PGlite](https://pglite.dev) — an in-process WASM Postgres — so there's no server, network, or cloud account required. `DATABASE_URL` defaults to `file:./data/whaikey` (a local PGlite data dir); tests use an in-memory instance.

## Deployment (Vercel)

The app runs on Vercel serverless. Serverless functions have no persistent local disk, so **production uses hosted Postgres ([Supabase](https://supabase.com))** while local dev/tests use PGlite. The driver is chosen at runtime from the connection string — see [`src/db/index.ts`](./src/db/index.ts): a `postgres://` URL uses `postgres-js`, anything else uses PGlite. The schema, queries, and migrations are identical across both.

### 1. Provision the database (Supabase Postgres)

Create a project at [supabase.com](https://supabase.com/dashboard) (or via the Supabase CLI). Then grab the **connection pooler** string:

- Dashboard → **Project Settings → Database → Connection string → "Transaction pooler"** (port `6543`).
- It looks like `postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`.

Use the pooler URL (not the direct `5432` connection) for serverless; the driver disables prepared statements so it's pgbouncer-compatible. Any hosted Postgres (Neon, RDS, …) works too.

### 2. Create the Vercel project

Import the GitHub repo at [vercel.com/new](https://vercel.com/new). Vercel auto-detects Next.js — no build config needed. GitHub Actions remains the test gate (`.github/workflows/ci.yml`); Vercel builds on every push and creates a preview deployment per branch/PR.

### 3. Set environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Value | Environments |
| --- | --- | --- |
| `DATABASE_URL` | Supabase pooler URL (from step 1) | Production, Preview |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` | Production, Preview |
| `BETTER_AUTH_URL` | your production URL, e.g. `https://whaikey.vercel.app` | Production |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (step 5) | Production |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret (step 5) | Production |
| `ANTHROPIC_API_KEY` | Anthropic API key ([console](https://console.anthropic.com/)) | Production, Preview |

Notes:
- On **preview** deploys `BETTER_AUTH_URL` is unset and the server falls back to the per-deploy `VERCEL_URL`, so the app boots. Google sign-in itself only works on production (its redirect URI is fixed), so exercise previews **signed-out** (search → bottle detail work without auth).
- The API routes that touch the DB or Anthropic pin `runtime = "nodejs"` (never edge); `/api/chat` sets `maxDuration = 60`.

### 4. Migrate & seed the production database

Point the migrate/seed scripts at the remote DB (they read `DATABASE_URL`):

```bash
DATABASE_URL="postgres://…pooler.supabase.com:6543/postgres" pnpm db:push   # apply migrations
DATABASE_URL="postgres://…pooler.supabase.com:6543/postgres" pnpm db:seed   # load the bottle catalog
```

### 5. Google OAuth

1. [Google Cloud Console](https://console.cloud.google.com/) → create/select a project.
2. **APIs & Services → OAuth consent screen** → External → add app name, support email, and your email as a test user.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
4. **Authorized JavaScript origins:** `https://<your-domain>` (e.g. `https://whaikey.vercel.app`).
5. **Authorized redirect URI:** `https://<your-domain>/api/auth/callback/google`.
6. Copy the client ID/secret into the Vercel env vars above.

Apple sign-in can be added later the same way (`APPLE_CLIENT_ID` / `APPLE_CLIENT_SECRET`); it activates automatically when those vars are present.

### 6. Deploy

Push to a branch for a **preview** deploy; verify signed-out search → bottle detail. Then **promote to production** (Vercel dashboard → Deployments → Promote, or merge to `main`). After promotion, confirm Google sign-in and the AI chat concierge.
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

# Whaikey — Whiskey Tracking App Plan

An AI-native whiskey tracking app, inspired by wine apps like **Vivino** (social scanning + ratings) and **InVintory** (beautiful personal cellar management), but built for whiskey from day one with AI at the core — not bolted on.

> **Last refreshed 2026-09-03** against HEAD `6dfb4ff` by the [September 2026 review](./docs/REVIEW_2026-09.md). §2 (current state), §3 (the v1 line), §5 (roadmap) and §12 (decisions) are the sections that go stale; update them on every PR that changes surface area.

> Deep dives: [docs/FEATURES.md](./docs/FEATURES.md) (feature map, REFERENCE) · [docs/STORYBOARD.md](./docs/STORYBOARD.md) (target IA and screen boards, **BINDING** for UI) · [docs/DESIGN.md](./docs/DESIGN.md) (design system, **BINDING**) · [docs/SOCIAL.md](./docs/SOCIAL.md) (social layer, **BINDING** for anything user-to-user) · [docs/COMPETITORS.md](./docs/COMPETITORS.md) · [docs/DATA_SOURCES.md](./docs/DATA_SOURCES.md) · [docs/SOURCING_AT_SCALE.md](./docs/SOURCING_AT_SCALE.md) · [docs/SUBSCRIPTION_CATALOG_AUTOMATION.md](./docs/SUBSCRIPTION_CATALOG_AUTOMATION.md) · [docs/NATIVE_APP.md](./docs/NATIVE_APP.md) · [docs/APP_STORE_SETUP.md](./docs/APP_STORE_SETUP.md) · [docs/REVIEW_2026-09.md](./docs/REVIEW_2026-09.md) (findings and work packages)

---

## 1. Vision & Principles

**Vision:** The fastest way to remember, understand, and grow your whiskey journey. Scan a bottle, get instant knowledge, log a pour in seconds, and have an AI companion that knows your palate better than you do.

**What the app is for.** Five verbs, in the order a drinker actually meets them. Every feature should be traceable to one of them, and a feature that serves none of them is a delighter at best:

| | | Looks like |
|---|---|---|
| **Explore** | Widen what you've met | Regions, countries, distilleries, cask types and styles you haven't tried yet — surfaced as territory, with the next step suggested |
| **Learn** | Understand what you're drinking | Whiskey School, cask and production explainers, your notes read against the producer's and the critics' |
| **Track** | Keep what you'd otherwise forget | Bottles, pours, notes, fill levels, spend — private by default, exportable always |
| **Refine** | Get better at tasting | The flavor wheel, calibration against published notes, blind flights, a palate model that sharpens as you feed it |
| **Share** | Do it with other people | Friends' notes beside yours, Same Dram, clubs, flights, taste twins, passports compared |

**Explore and Share are the two we have historically under-built**, and both are the point of the thing: whiskey is a hobby people fall into because someone poured them something, and it stays a hobby because there's always a region, a distillery or a cask finish you haven't met. The app should feel like a passport and a table of friends, not a ledger.

**The v1 promise, in one sentence:** *A whiskey drinker can find any bottle they're holding in under 10 seconds, record what they thought of it in two taps, see what they've tasted and where they haven't been — and get their data out.* Track and Explore are the v1 spine; Refine rides on the wheel that exists; Learn and Share are shipped enough to keep and are frozen until the spine is closed (§5.4).

**Guiding principles:**

1. **AI-native** — AI isn't a feature tab; it powers search, tasting-note capture, recommendations, and a conversational assistant throughout the app. It is also optional: every AI feature degrades to a working manual path.
2. **Fast above all** — Logging a pour or scanning a bottle must take under 10 seconds. Optimistic UI, offline-capable, instant search. The primary action of every screen is above the fold (STORYBOARD.md).
3. **User-friendly** — A collector's app that a beginner can use. Progressive disclosure: simple by default, deep when you want it.
4. **Your palate, not the crowd's** — Community ratings are context; personal taste modeling is the product. Friends' palates are the *most useful* context, which is why the social layer compares palates rather than aggregating them into an average.
5. **Social by comparison, never by consumption** — Whiskey is drunk with people, so the app is better with people in it. But the shared thing is *the bottle* and the compared thing is *your palate* — never how much or how often you drink. Every social mechanic must be winnable by a moderate drinker, or it doesn't ship ([docs/SOCIAL.md](./docs/SOCIAL.md) §3).
6. **Curiosity is what we celebrate** — The scoreboard, where there is one, counts *distinct things met*: regions, countries, distilleries, cask types, styles, descriptors. Breadth saturates — the fiftieth pour of the same bourbon moves nothing — which is exactly why it is safe to make it fun, competitive and shareable. A 15 ml sample at a bar earns the same as a bottle, so the cheapest way to fill a passport is to drink *less of more*, with friends. This is not a loophole in the responsible-drinking stance; it is the substitute the stance was designed to make room for ([docs/SOCIAL.md](./docs/SOCIAL.md) §3.2).

**What we will never build** (one list, cross-linked from AGENTS.md): consumption mechanics of any kind — streaks, volume/ABV/time-of-day badges, leaderboards sorted by a consumption quantity, pour-nudging or finish-this-bottle notifications, "friends drinking now" presence; money data in any social projection; dark patterns; password auth; paywalling data users entered themselves.

---

## 2. Current state — read this before writing code

**As of 2026-09-03, HEAD `6dfb4ff`.** Whaikey is a Next.js 16 App Router web app on Vercel, wrapped by Capacitor for iOS/Android, with Drizzle over Postgres (Supabase in production; PGlite locally and in tests), Better Auth (Google/Apple only), and an Anthropic-Messages-compatible AI client that prefers OpenRouter when configured. 24 page routes, 34 API route files, 55 tables, 22 migrations, 134 unit-test files (1,288 tests), 41 mobile visual baselines, 7 GitHub workflows. `pnpm typecheck && pnpm lint && pnpm test && pnpm build` is green.

### 2.1 Live and solid

- **Core loop:** search → bottle detail → own/tried/wishlist → pour log with half-star ratings, nose/palate/finish, flavor-wheel tags with intensity → journal. My Bar carries fill level, spend, cost-per-pour, lifecycle statuses and a library flavor heat map with three lenses (mine / label / compare).
- **Identification:** dual-mode camera (barcode loop + label shutter), on-device framing guidance, live label ID, async capture queue with undo, crowdsourced UPC → bottle map, CSV/competitor import with AI column mapping.
- **Flavor contract:** `src/lib/flavor-wheel.ts` — 8 wedges, 55 leaves — shared by bottle profiles, notes, the wheel UI, calibration and AI extraction.
- **AI (optional everywhere):** chat with streaming and 7 tools, note extraction from dictated/typed text, label scan, pairings (food/cigar/cocktail, cached), explained recommendations (discovery + tonight) that degrade to deterministic reasons with no key.
- **Social S1–S2 and most of S3:** share links with revocation, comparison on the link, profiles as palate cards, follow/approve/block, per-pour visibility (default Only me), "From your friends" Home module, Same Dram, cheers, comments + reports, taste twins, phone (HMAC) and QR discovery, one-tap "make everything private".
- **Passport:** countries / regions / styles met, catalog-share tier badges (Oak → Amber) that never downgrade, crests on profile and bottle, passport hooks on the discovery rail.
- **Whiskey School:** 9 lessons with quizzes and a flavor-wheel explorer.
- **Catalog pipeline:** 9 source adapters (TTB COLA, Iowa, Oregon, Utah, BC, Systembolaget, Vinmonopolet, WHISKY:EDITION, CSV), enrichment, sold-verification queue with a subscription-CLI worker, a source-provenance graph, issue-driven feedback review, 4 scheduled workflows.
- **Native:** Capacitor shell loading the deployed site, capability layer with web fallbacks, PKCE + state-bound device-code sign-in, offline pour queue, push-token registration, Android debug + iOS compile in CI, release workflow awaiting credentials.

### 2.2 Live but weaker than it reads

- **Search** is `ILIKE` substring over name/distillery/alias with query + category filters. It does not tolerate misspellings and has no supporting trigram index.
- **"Est. value"** is a user-typed field falling back to catalog average price, shown as a point number.
- **Voice notes** are browser dictation (Web Speech), unreliable in an iOS WebView; there is no audio upload.
- **Passport** counts 3 of 6 dimensions and is reachable only from a claimed social profile; no counters on My Bar.
- **Learn progress** lives in localStorage.
- **Reports** are written and never read; no moderation surface exists.
- **Community consensus** is live at `/bottles/[id]/compare` ahead of the jurisdiction review SOCIAL.md §14 makes its precondition.

### 2.3 Not built, and load-bearing

- **No way to add a bottle the catalog lacks** — no `POST /api/bottles`; a scan, search or import miss is a dead end.
- **No age gate, no data export, no account deletion, no Terms, no Privacy Policy, no billing or entitlements, no analytics, no error monitoring, no settings page, no sign-out control, no moderation queue.**
- No clubs, blind flights, samples, distillery visits, passport diffing, palate share card, flights/blind mode, 100-point rating mode, similar-bottles rail, chat tools `log_pour_draft` / `recommend_bottles` / `get_price_info`.
- No `minShellVersion` kill switch for the native shell; no reviewer demo account (the app is social-login-only).

### 2.4 The UX diagnosis

Screens are individually well crafted but the four highest-traffic ones (Home, My Bar, Log a pour, Bottle) are 2–3.5 viewports long with the primary action at the bottom; the nav spends two slots on the thinnest surfaces; there is no back, edit, delete, settings or sign-out; and the same job is drawn several ways. [docs/STORYBOARD.md](./docs/STORYBOARD.md) is the target and [docs/REVIEW_2026-09.md](./docs/REVIEW_2026-09.md) §1 and §7 (Lane B) the order of work.

### 2.5 Do not trust until rewritten

- `docs/SOCIAL.md` §8 principle 7, `docs/FEATURES.md` §8.3 and §12: all assert an age gate that does not exist.
- `docs/APP_STORE_SETUP.md` §6.2 says to answer "no UGC"; the app ships profiles, feeds and comments today. §1/§6.4 demand a password demo account the app forbids.
- `docs/SOCIAL.md` §6.1's nav list contradicts its own §6.3 amendment, and both predate STORYBOARD.md §1.1.
- `docs/FEATURES.md` §2.1 (fuzzy search), §4.2 (100-point storage), §11.3 (counters on My Bar): promised, not shipped.
- `docs/SOURCING_AT_SCALE.md`'s "~25,000 bottles" describes a production database no repo artifact can confirm (the committed seed is 269 bottles).

---

## 3. The v1 done line

v1 ships to a store when every box is ticked. Nothing on this list is optional and nothing not on it blocks.

**Core loop**
- [ ] Any bottle a user can hold resolves: scan or search hits the catalog, **or "add this bottle" creates a private bottle usable immediately** (review queue for global visibility). Catalog-miss dead-end rate = 0.
- [ ] Search tolerates a misspelling (`pg_trgm`), with a 50-query evaluation set committed.
- [ ] Pour logging: two taps, works offline on web and native, idempotent on flush.
- [ ] Bottle page: relationship and log action above the fold; your history; flavor profile; honest price framing (ranges); pairings.
- [ ] Every non-tab route has back; every mutation has undo or confirm; loading/error/not-found states exist.

**Explore**
- [ ] Passport counters render on My Bar and Explore for a user with no social profile.
- [ ] All six dimensions counted (distilleries, casks, descriptors are `count(distinct)` over existing columns).

**Own your data**
- [ ] Export (JSON + CSV) of notes, inventory, pours and graph — one tap, no tier.
- [ ] Hard account deletion with a stated policy for shared and aggregate contributions.
- [ ] Settings page: account, sign-out, rating scale, units, privacy defaults, notifications.

**Legal to operate**
- [ ] Age gate at signup; store availability aligned to markets.
- [ ] Privacy Policy and Terms live, covering AI processing (and the provider), photos, the user-photo licence grant, community opt-in.
- [ ] Moderation queue an operator can work; report and block flows (shipped) documented for store review.
- [ ] Support URL and an in-app feedback path.

**Observable**
- [ ] Error monitoring in production.
- [ ] Analytics sufficient to compute SOCIAL.md §12's cohort-adjusted pours-per-active-user metric and per-user AI cost.
- [ ] Search p95 and scan-to-shelved p95 measured (CI or RUM), with NATIVE_APP.md §1.4's tripwires wired to real numbers.

**Shippable**
- [ ] Reviewer access solved; App Store UGC answers corrected; `minShellVersion` kill switch live.
- [ ] The three High security findings and the P0 closed (review §2, §3).

**Explicitly not in v1:** billing. Ship free, instrument willingness-to-pay (§6.5), then price.

---

## 4. Architecture & Tech Stack

### 4.1 The stack (as built)

- **App:** Next.js 16 App Router (TypeScript, Tailwind v4) on Vercel, wrapped by **Capacitor** for iOS/Android. The native shell loads the deployed site over HTTPS rather than a static export, so server components and cookie auth are unchanged. The React Native decision, tripwires and native architecture are in [docs/NATIVE_APP.md](./docs/NATIVE_APP.md).
- **Backend:** route handlers under `src/app/api` (`runtime = "nodejs"`, never edge). Drizzle over Postgres — Supabase (pooler URL) in production, PGlite in-process locally and in tests; the driver is chosen from the connection string in `src/db/index.ts`. **Better Auth**, social login only (Google, optional Apple).
- **AI layer:** `src/lib/ai/client.ts` selects the provider at runtime — **OpenRouter** when `OPENROUTER_API_KEY` is set, Anthropic direct otherwise; both speak the Messages API. Two model roles, `chatModel()` (chat, pairings, rec explanations) and `fastModel()` (extraction, label scan), each overridable by `WHAIKEY_CHAT_MODEL` / `WHAIKEY_FAST_MODEL`. **Model ids live in code, not here.** On the OpenRouter path prompt caching and hosted web search are unavailable. Missing keys ⇒ routes return 503 and the UI hides AI affordances; the manual loop never blocks. The catalog verification lane runs separately on an authenticated Claude Code subscription (`src/lib/ingest/verification-queue.ts`).
- **Search:** today, Postgres `ILIKE` substring over name/distillery/aliases (`src/lib/search.ts`). Planned: `pg_trgm` GIN indexes and `similarity()` for misspellings (§3). Embeddings/pgvector are **not** planned until a committed search evaluation shows substring + trigram is the bottleneck.
- **Analytics / monitoring:** not adopted yet (§10). Sentry and a minimal event set are on the v1 line.

### 4.2 High-level architecture

```
┌──────────────────────┐   ┌──────────────┐
│ Capacitor shell      │   │ Browser /    │
│ (iOS / Android)      │   │ PWA          │
│ • capability layer   │   │              │
│   src/lib/native/*   │   │              │
│ • device-code auth   │   │              │
│ • offline pour queue │   │              │
└──────────┬───────────┘   └──────┬───────┘
           │        HTTPS         │
           ▼                      ▼
┌────────────────────────────────────────────────────────┐
│ Next.js App Router on Vercel                           │
│ • server components + route handlers (runtime=nodejs) │
│ • Better Auth (cookie sessions; Google / Apple)        │
│ • src/lib/session.ts — the only auth seam              │
│ • Drizzle ──▶ Postgres (Supabase prod · PGlite local)  │
│ • src/lib/ai/client.ts ──▶ OpenRouter | Anthropic      │
│ • per-user AI rate limits (DB-backed, atomic)          │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────┐
│ GitHub Actions (incl. a self-hosted runner)            │
│ • catalog-sync · source-backed scan · verification     │
│ • whiskey-feedback review · native release             │
│ ──▶ same Postgres (catalog-production environment)     │
└────────────────────────────────────────────────────────┘
```

Key decisions:
- **All AI calls server-side** through one client; no keys in the client; per-user rate limiting; per-bottle caching of pairings and recommendation explanations.
- **AI chat uses tool calling** against internal functions: `search_bottles`, `get_bottle_details`, `get_my_bar`, `get_pour_history`, `get_tasting_notes`, `get_pairings`, `add_to_wishlist` (the only write tool; idempotent, user-scoped). Planned: `log_pour_draft` (with inline confirmation), `recommend_bottles`, `get_price_info`.
- **Offline-first pour logging**: queue writes locally, sync on reconnect — on web and native — with a client-generated idempotency key (§4.6).
- **Bottle database**: seeded + ingested from open datasets with AI-assisted enrichment and provenance; user-submitted bottles go into a review queue (§3). Sourcing in §4.5.

### 4.3 Core data model

**`src/db/schema.ts` is the source of truth** (55 tables, documented inline). The conceptual sketch:

```
user(id, palate_profile jsonb)            user_profiles(user_id, handle, display_name, avatar_url, bio, is_public, social_enabled, phone_hash)
bottles(id, distillery_id, name, category, country, region, age_years, abv, cask_types[],
        msrp, avg_price, flavor_profile jsonb, producer_flavor_tags, image_url, status)   -- verified / imported / user_submitted
distilleries(id, name, country, region)
bottle_aliases · bottle_upcs(confirmed_count) · bottle_verifications · bottle_resources · bottle_claims · bottle_media · catalog_sources
user_bottles(user_id, bottle_id, relationship own/tried/wishlist, status, fill_level, purchase_price, purchase_date, store, est_value, location, notes)
pours(user_id, bottle_id, user_bottle_id?, rating 0.5–5.0, serving_style, amount_ml, context jsonb, visibility, created_at)
tasting_notes(pour_id, nose, palate, finish, freeform, flavor_tags jsonb {leafId: intensity}, extracted_by)
pairings(bottle_id, type food/cigar/cocktail, suggestion, rationale, user_feedback_score) · rec_explanations · ai_rate_limits
chat_sessions / chat_messages
price_history(bottle_id, date, price, source)      -- written by verify-sold; not yet read by any surface
follows(follower, followee, state) · blocks · reactions(cheers) · comments · reports · phone_lookups · pour_shares(code, revoked_at)
passport_tiers(user_id, family, value, tier, achieved_at)   -- never downgrades
native_auth_codes · push_devices
```

Rules that hold across the model:
- **Ratings** are half-stars 0.5–5.0 stored as a double (decided, §12). A 100-point display mode, if ever built, is a transform, not a storage change.
- **Social read-path rule:** every social surface reads through an explicit projection that selects columns individually (`getPublicPourShare()` pattern), never a whole `pours` or `user_bottles` row. Purchase price, collection value and spend are structurally absent from those projections.
- **Origin:** `bottles.country` always set; `bottles.region` sub-national or null (`bottleOrigin()` enforces at seed time).
- **Money** is currently `double precision` in USD with no currency column; moving to integer minor units with a currency is on the roadmap (§5, track C).

### 4.4 Environments, deployment & operations

- **Environments:** local (PGlite, `file:./data/whaikey`), Vercel preview (signed-out only; Google redirect URI is fixed to production), production (Supabase pooler). **Missing:** a staging environment with real Postgres where social features can be exercised — on the roadmap (track L).
- **Deploy:** Vercel builds on every push; `scripts/build.mjs` runs `pnpm db:push` then `next build`. Migrations therefore land **before** the build succeeds; schema changes must be backward compatible with the previous release (expand/contract) until the migration step moves post-build.
- **Migrations:** generated only via `pnpm db:generate` (custom backfills via `--custom`); never hand-edited. Nothing yet verifies that production's migration state matches `main` while scheduled catalog workflows write to production — a drift check is on the v1 line (§3, Observable).
- **Backups & restore:** rely on Supabase point-in-time recovery; a documented restore drill is required before launch.
- **Secrets:** `BETTER_AUTH_SECRET` (fails closed in production), `WHAIKEY_PHONE_KEY` (**never rotate** — stored phone hashes only match under the same key; key versioning is the eventual fix), OAuth client secrets, `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY`, the `catalog-production` environment's `DATABASE_URL` on the self-hosted runner, and a persisted Claude Code subscription login on that runner. One inventory with rotation notes lives in README §Deployment; keep it there.
- **Self-hosted runner:** patching, monitoring, subscription-login expiry and lease reclamation on runner death are undocumented — track K.
- **Domain:** `app.whaikey.com` is assumed by the release workflow and store runbook but not yet committed (§12). Deep links, OAuth redirect URIs, `.well-known` files and the Capacitor `server.url` all depend on it.

### 4.5 Data sourcing (summary — full strategy in [docs/DATA_SOURCES.md](./docs/DATA_SOURCES.md))

There is no single whiskey API; the catalog is assembled in layers, mostly free at launch:

| Layer | Launch sources (free) | Paid upgrades (when funded) |
|---|---|---|
| **Bottle catalog** | TTB COLA registry, Iowa Liquor Products, Oregon/Utah/BC/Systembolaget/Vinmonopolet catalogs, WHISKY:EDITION (CC BY 4.0 — attribution surface required), Wikidata distilleries | COLA Cloud API, Whiskybase *licensing conversation* (never scraping) |
| **Barcodes** | Own DB first (crowdsourced confirmations); UPCitemdb trial; Open Food Facts fallback (ODbL — never merged) | UPCitemdb Dev |
| **Prices/valuation** | Iowa monthly price data, control-state price books, auction-trend APIs, affiliate feeds | Wine-Searcher, Whiskystats |
| **Label scanning** | Barcode-first → OCR text match → vision model | Visual matching seeded with COLA label images |

Principles: every third-party lookup converts into a first-party record; every feed has a fallback; the legal checklist (COLA image posture, ODbL isolation, CC BY attribution, feed ToS) is **one checklist with owners and dates** in §9.5 and clears before launch. The pipeline's steady-state cost (scheduled syncs + enrichment of new rows) needs a budget and an alarm (track K).

### 4.6 Offline, sync and media

- **Queue:** ✅ `src/lib/native/offline-queue.ts` persists pours in localStorage/Preferences and flushes on mount, `online`, tab foreground and app resume — on **both** web and native. One in-flight flush at a time; the queue is re-read before every write, so a pour logged mid-flush is kept.
- **Idempotency:** ✅ every pour carries a client-generated `clientId`, minted before the first send and reused by every retry; `POST /api/pours` is unique on `(userId, clientId)` and returns the existing row and note on replay, so a lost response cannot double-log or double-decrement the fill level.
- **Conflicts:** pours are append-only, so create-conflicts do not arise. Shelf edits (fill level, purchase info) are last-write-wins per field; a queued edit older than the server row is dropped with a toast.
- **Media:** not yet built. When it is: object storage (Supabase Storage or S3) for user label photos and avatars, size/format limits, moderation of user images, a licence-metadata field, and deletion on account deletion. `bottles.imageUrl` remains a URL to source-owned media with attribution.

### 4.7 The palate model (what makes it AI-native)

1. Every tasting note (typed, tapped, or spoken) → the fast model extracts normalized flavor tags mapped to the wheel taxonomy; the user confirms.
2. Ratings × flavor tags × recency decay accumulate into `user.palate_profile` (`src/lib/palate.ts`, persisted by `palate-store.ts`).
3. Recommendations = palate similarity against bottle profiles → filtered by price band and shelf → nudged by passport gaps and taste twins → **explained** (by the chat model when configured, deterministically otherwise).
4. The same profile grounds chat answers, pairings, "what to pour tonight", Same Dram and taste twins.

Performance rule: palate reads are bounded (recent history, capped rows) and the persisted profile is authoritative for social and recommendation reads; recomputation happens on write, after commit.

---

## 5. Roadmap — one timeline, five tracks

Tracks run in parallel and are named so that "Phase 2" is never ambiguous: **C** core/product, **L** legal & operations, **N** native, **S** social, **K** catalog. Work packages (WP-n) are specified in [docs/REVIEW_2026-09.md](./docs/REVIEW_2026-09.md) §7.

### 5.1 History (what actually shipped, in order)

| When | Delivered |
|---|---|
| 2026-Q2 | Next.js scaffold, PGlite/Postgres parity, Better Auth social login, seed catalog, search, bottle detail, My Bar with spend, pour log with wheel and half-stars, journal, flavor wheel input/viz/heat map, AI chat + extraction + pairings + recommendations, label and UPC scan, CSV import |
| 2026-07 | Native shell (N0–N2): capability layer, device-code auth, offline queue, push-token registration, CI compiles; fonts pinned after a CI outage; Whiskey School |
| 2026-08 | Social S1 (share revocation, comparison on the link), S2 (profiles, follows, visibility, friends module, Same Dram, cheers, blocks, privacy reset), most of S3 (comments, reports, taste twins, phone/QR discovery); onboarding wizard and Home/My Bar/Friends redesign; source-backed catalog pipeline, verification queue, origin model; passport tiers and crests; scan sharpening |
| 2026-09 | This review: STORYBOARD.md, refreshed plan |

### 5.2 Now — two lanes, in parallel

**Lane A (C): stop the bleeding.** ✅ WP-1 offline queue + idempotency · ✅ WP-2/3 native auth binding and cookie storage (bar the Universal Link callback, blocked on the bundle id) · ✅ WP-4 security headers (CSP report-only pending its first production reports) · ✅ WP-5 aggregate leak, body limits, AI timeouts.

**Lane B (C): the focus and polish pass**, in STORYBOARD.md §5 order. WP-6 back/nav/toast/loading · WP-7 pour sheet · WP-8 bottle action bar · WP-9 My Bar shelf-first · WP-10 journal edit/delete + one Share sheet · WP-11 settings, export, delete · WP-12 the new nav (Home · Bar · ＋ · Explore · You), `/passport` with six dimensions and counters on Bar, Home cut to three modules · WP-13 first run · WP-14 shared search/row components · WP-15 share-page CTA.

**Lane C (L): launch blockers.** WP-16 user-submitted bottles · WP-17 age gate · WP-18 moderation queue, store answers, reviewer access, ToS/Privacy, support · WP-19 monitoring + the guardrail metric + publish S1/S2 overlap numbers · WP-20 kill switch, push-token rule, Android backup flag.

**Lane D (C/K): scale before the catalog grows.** WP-21 bounded discovery + indexes + cached totals · WP-22 trigram search + evaluation set · WP-23 bounded palate reads · WP-24 batched ingest and atomic finalize · WP-25 money/timezones/dates/budgets/TTLs · WP-26 Postgres CI lane and route tests.

### 5.3 Then

- **C:** collection value done honestly (range + trend + source label), price-history surfacing, `/stats` (private pours-over-time stays private), palate share card, similar-bottles rail, the three missing chat tools, native voice recording (the signature feature on the platform that matters).
- **N:** store launch — closed test, screenshots, store records, credentials (NATIVE_APP.md N4).
- **S:** re-open S3's remainder (clubs, blind flights, samples, passport diffing) **only after** the S1/S2 overlap numbers SOCIAL.md §15 promised are published and clear §12's targets. Flights are the strongest acquisition argument in the doc set and are judged on that evidence.
- **Monetization:** entitlements + billing (§6.6) after beta usage data.
- **Later:** distillery visits (needs geolocation in the shell), club passports, S4 community scale (after the jurisdiction review), Wrapped, widgets, price alerts, gift mode.

### 5.4 Frozen scope (and what unfreezes it)

| Frozen | Unfreezes when |
|---|---|
| Clubs, blind flights, samples, passport diffing, club passports, distillery visits | S1/S2 overlap and SOCIAL §12 metrics published and healthy; Lane C complete |
| S4 community consensus and public discovery (and the community segment already live on `/bottles/[id]/compare` is a §12 decision) | Jurisdiction review done |
| New Whiskey School content, AI personalisation, Pro gating of lessons | Progress persisted server-side; v1 line closed |
| Catalog pipeline feature work (batch API migration, new sources) | Steady-state cost model and budget alarm exist; maintenance and cost control only until then |
| pgvector / embeddings / semantic search | Committed search evaluation shows substring + trigram is the bottleneck |
| Wrapped, widgets, price alerts, gift mode, infinity bottles, store picks, 100-point mode | v1 line closed |

**Structural invariant on every social release:** nothing becomes visible to a second user until the visibility model and block checks are enforced on the read path that serves it (SOCIAL.md §13). Consumption guardrails are enforced as mechanic bans in review and verified by the cohort-adjusted metric (SOCIAL.md §12), which must exist before the next social release.

---

## 6. Monetization

**Model: freemium subscription.** The free tier must be genuinely useful (that's the growth engine — Vivino proved free scanning drives adoption), while the AI concierge and collection analytics justify a paid tier because they have real per-use value *and* real per-use cost.

### 6.1 Free tier — "the spreadsheet killer"

Everything needed to replace notes apps and win the habit:

- Unlimited bottles in My Bar, wishlist, and tried list.
- Pour logging, ratings, structured notes, flavor wheel input.
- Bottle search + detail pages, label scanning (fair-use cap, e.g. 20 scans/mo).
- **Limited AI chat** — e.g. 10 messages/month, enough to feel the magic and hit the wall.
- Basic spend total (sum of purchase prices).
- Export, always.

### 6.2 Premium — "Whaikey Pro" (~$5.99/mo or $49/yr; ~30% annual discount)

Sell the *palate + portfolio* story — "know your taste, know your bar's worth":

- **Unlimited AI concierge** chat + voice-note extraction.
- **Deeper social analysis** (not social *access* — see 6.2.1): full palate-match breakdowns across your graph, club analytics ("what is this club missing?").
- **Palate wheel + explainable recommendations** ("because you loved X…").
- **Collection value tracking** — market value estimates as ranges, value-over-time chart, cost-per-pour, spending analytics.
- Unlimited label scans, price history on bottles, wishlist price alerts (when built).
- Blind tasting mode, flight comparison, CSV/PDF insurance reports.
- Yearly "Whiskey Wrapped" in full (free users get a teaser).

Pricing logic: whiskey collectors routinely spend $50–100+ per bottle; $6/mo is < 2% of a single mid-shelf purchase. Anchor the annual plan as "less than one pour of Blanton's per month."

#### 6.2.1 Social is free — all of it

Same logic that keeps scanning free: the graph **is** the growth engine, and a paywalled graph doesn't grow. Profiles, following, the feed, cheers, comments, share links, Same Dram vs. friends, clubs, and blind flights — **hosting included, at any size** — are free forever. A flight night is the app's single best acquisition moment (every guest installs to participate); charging the host would tax the growth loop at its strongest point.

**The line:** if a feature makes the network bigger, it's free; if it makes *your understanding* of the network deeper, it can be Pro. Friends' recommendations are also the most natural buying moment in the app — the §6.3 affiliate rule (never pay-to-rank, always disclosed, always downstream of an honest recommendation) applies there without softening.

### 6.3 Later revenue streams (post-traction, in order of attractiveness)

1. **Affiliate/referral on recommendations** — "buy near you / online" links from bottle pages and rec cards. Strict rule: recommendations are *never* pay-to-rank; affiliate revenue is disclosed and downstream of an honest rec, or trust dies.
2. **Retailer/brand analytics (B2B)** — aggregated, anonymized demand and flavor-trend data. Privacy-first: opt-out, aggregate-only, no individual data sales.
3. **Distillery partnerships** — sponsored (clearly labeled) tasting flights, early releases, virtual tastings inside clubs.
4. **One-time IAPs** — lifetime unlock option (~$149) for subscription-averse collectors; gift subscriptions.

**Explicitly not doing:** selling user data, ads in the tasting flow, pay-to-win community rankings, or paywalling data users entered themselves (your notes/inventory are always exportable — even on free).

### 6.4 Unit economics sanity check

- Main variable cost is AI inference. Mitigations: the fast model for high-volume extraction, per-bottle caching of pairings/recs, per-feature rate limits, premium tier absorbs heavy chat users.
- Rough target: keep AI cost per premium user < $1/mo → healthy margin at $5.99 **net of the 15–30 % store cut on IAP** (web checkout at the same price avoids it; parity rules apply).
- Conversion assumption to validate in beta: 3–5% free→paid. **Neither number is measurable today** — per-user cost attribution is on the v1 line (§3).

### 6.5 Rollout

- **Beta:** everything free, instrument usage to find the real willingness-to-pay lines.
- **Launch:** grandfather beta users with 3 months of Pro; introduce the paywall with the limits above.
- Revisit the free-tier AI message cap based on actual cost data — generosity is a growth lever, not a loss center, if caching works.

### 6.6 Implementation (not yet built)

There is no entitlement concept in the schema or code. When billing lands: an `entitlements` row per user (tier, source web/ios/android, renews_at), one `hasEntitlement(user, feature)` helper used by every gated surface, RevenueCat (or StoreKit 2 + Play Billing direct) for stores and Stripe for web, receipt validation server-side, grandfathering by account creation date, and export/deletion unaffected by tier.

---

## 7. Risks

| Risk | Tripwire | Mitigation |
|---|---|---|
| **Catalog dead-end** — a user's bottle isn't in the catalog and cannot be added | Scan/search miss rate; any miss with no follow-up action | User-submitted bottles (WP-16) before any further ingest investment; fuzzy search so near-misses resolve |
| Bottle database quality/coverage | % of shelved bottles with verified status, flavor profile, image | Layered sourcing (§4.5); enrichment; feedback review; catalog-quality metrics (§10) |
| Data source revocation (Systembolaget/LCBO precedent) | A scheduled sync failing twice | Every feed has a fallback; convert lookups into first-party records |
| **Unticked data licensing** (CC BY attribution, ODbL isolation, COLA image posture) | Any source surfaced without attribution | One checklist with owners and dates (§9.5) cleared before launch |
| AI cost per user | Cost/user/month > $1 on Pro or > $0.20 on free | Fast model for volume, caching, per-feature budgets, tier caps; cost telemetry first |
| **Unbounded pipeline cost** | Monthly workflow spend without a budget line | Cost model + alarm before new sources (track K) |
| Label scan accuracy | Correction rate on confirm-or-correct | Corrections stored as eval data; confirm-or-correct always |
| Market price data | Any point estimate shown without a range | Ranges/trends only; user-entered comps |
| **No acquisition plan** | Sign-ups/week flat after launch | Share-page CTA, flight nights when unfrozen, first-week retention instrumented |
| **Store rejection compounding** — UGC answer, age gate, moderation, demo account | Any submission without all four resolved | Lane C before the first store record |
| **Prod migration drift** — scheduled workflows write to a DB whose schema may lag `main` | Migration state ≠ journal head at deploy | Drift check in CI/deploy; expand/contract until migrations move post-build |
| **Single-operator load** — moderation and verification are ongoing duties | Report age > 72 h; verification queue growth | Size the load; queue SLAs; automation only where evidence is provenance-backed |
| Scope creep (this doc proves it) | Any work outside §5.2 lanes before the v1 line | Frozen list (§5.4) with named tripwires |
| **Social drifts into rewarding consumption** | The cohort-adjusted weekly pour rate rises after a social release | Mechanic bans enforced in review (SOCIAL §3.1); the metric must exist before the next social release |
| **Privacy leak through a social surface** | Any social projection touching price/spend; any aggregate including private pours | Projection rule (§4.3); fix review SEC-M2; decide SEC-M7 (§12) |
| **Sparse overlap** — friends haven't tasted the same bottles | S1/S2 overlap numbers below SOCIAL §12 targets | Publish the numbers; descriptor-level comparison; discovery framing |
| Social is table stakes, not a wedge | — | Only ship social downstream of the taxonomy + calibration moat |

---

## 8. Notifications

Nothing sends today (`push_devices` stores tokens; no sender exists). When one does, this section is binding.

- **Allow-list** (SOCIAL.md §7.5): new follower · cheer or comment on your note · a friend tasted a bottle you've also tasted (batched, ≤ 1/day) · club and flight events you opted into · someone logged a note from a sample you sent.
- **Banned:** anything mentioning pouring or drinking now; "you haven't logged since…"; progress-toward-reward or "one region to go"; "friends drinking now"; fill-level or finish-this-bottle prompts; price alerts framed as urgency.
- **Delivery:** APNs/FCM via one server-side sender behind a queue; per-user preferences stored on `user_social_prefs.notify_prefs` with every category off-able; quiet hours; batching per category; unsubscribe link in any email.
- **Ownership of a token:** a token belongs to the account that registered it most recently **and** whose registration is fresh; stale reassignment rules per review SEC-M6.

---

## 9. Compliance, trust & operations

### 9.1 Age gate & jurisdiction
Date-of-birth or attestation at signup with a per-market minimum (21 US, 18 most others; align store availability to markets we can serve). One gate covers social; no re-check at first social action. Under-age existing accounts: social off, export offered, deletion after notice. **Not built** — WP-17.

### 9.2 Privacy: export, deletion, retention
- Export: JSON + CSV of bottles, pours, notes, chat, profile (minus phone hash), shares, passport; one tap, free forever.
- Deletion: hard delete of the user row (every user-owned table cascades), revocation of shares and push devices, session clear; comments on others' pours are soft-deleted to "[deleted]"; contributions to community aggregates are recomputed on next refresh. Policy stated in the Privacy Policy.
- Retention: native auth codes deleted on redemption and swept; rate-limit rows swept after 48 h; phone probes swept per `social.ts`; chat history kept until the user deletes it.
- Private by default everywhere; visibility never raised by the system; money never crosses a social boundary; palate provenance decided in §12.

### 9.3 Terms & Privacy Policy
Required before any store submission. Must cover: AI processing and the provider (OpenRouter or Anthropic) that sees notes and shelf data; the user-photo licence grant (DATA_SOURCES §6); community-contribution opt-in; age requirement; responsible-drinking stance; data retention and deletion; contact.

### 9.4 Moderation
Reports exist (`/api/social/reports`); nothing reads them. Required: an operator role (env-allowlisted user ids at first), a `/admin/reports` queue with hide/warn/ban actions, a 72-hour SLA, an appeals note in the ToS, and audit logging. Store review will ask.

### 9.5 Data licensing checklist (single list; owners and dates to be filled)
- [ ] TTB COLA image posture documented
- [ ] Open Food Facts (ODbL) never merged into our tables — verified by code review
- [ ] WHISKY:EDITION (CC BY 4.0) attribution surface live wherever its data appears
- [ ] Systembolaget mirror, BC OGL, Vinmonopolet terms reviewed
- [ ] Affiliate feed ToS reviewed before any link ships
- [ ] Whiskybase: licensing conversation only; no scraping
- [ ] User-photo licence in the ToS before any upload path ships

### 9.6 Store submission facts
UGC: **yes** (profiles, feeds, comments) — moderation, report and block flows documented. Age rating per alcohol content. Reviewer access: decision in §12. Support URL and privacy URL live. Native kill switch (`minShellVersion`) live.

### 9.7 Support & feedback
An in-app feedback sheet (mails a support address; attaches app version and platform) and a public support URL. The GitHub issue form remains for catalog corrections only.

### 9.8 Responsible-drinking stance
Enforced as mechanic bans in review (SOCIAL §3.1; §1's never-build list), verified by the cohort-adjusted pours-per-active-user metric (§10), and visible in copy: no volume headlines, no finish-this prompts, resources page linked from Settings.

---

## 10. Non-functional requirements & measurement

| Area | Requirement | How it is measured |
|---|---|---|
| Performance | Tab tap paints < 100 ms (skeleton); search results < 100 ms p95; scan-to-shelved < 3 s p95; cold start < 2 s | RUM on the three flows; a Lighthouse budget in CI; NATIVE_APP §1.4 tripwires wired to these numbers |
| Offline | Pour logging works offline on web and native; idempotent flush; shelf edits last-write-wins per field | Tests in `offline-queue.test.ts`; a Playwright offline scenario |
| Accessibility | VoiceOver/TalkBack on core flows; the wheel has a list-mode equivalent; dynamic type; 12 px floor; 4.5:1 contrast; 44 px targets | axe in the visual suite; a manual VoiceOver pass per release |
| Analytics | Event set: session, search, scan (hit/miss/submit), pour (source, taps), bottle add, share create/open, follow, export; **cohort-adjusted pours per active user per week** | PostHog or equivalent, server-side where possible; the guardrail metric on a dashboard the owner looks at |
| Error monitoring | Sentry on server and client, release-tagged; native crash reporting | Alert on error-rate spike per deploy |
| AI evaluation | Extraction accuracy against the 55 leaves; scan match rate; pairing sanity; enrichment correctness; every user correction stored as eval data | A committed eval set run on model or prompt change |
| Search quality | Recall@5 on a 50-query set incl. misspellings and slang | `src/lib/search.eval.ts` in CI |
| Catalog quality | Coverage by category/country; % with flavor profile, image, verified status; duplicate rate; scan resolution rate | Printed by `pnpm ingest --stats`; tracked per sync run |
| Testing | Unit on PGlite + a Postgres service-container lane; route tests for every handler; visual baselines CI-canonical | CI |
| Localization | v1 English; units (ml/oz) and currency per user; strings separable | Settings; schema `currency` column with money |

---

## 11. Surfaces

Target IA and per-screen boards: [docs/STORYBOARD.md](./docs/STORYBOARD.md) (v2, owner decisions in its §0). Nav: **Home · Bar · ＋ (pour sheet, scan-first) · Explore · Friends**; the profile lives behind the header avatar. Routes that must exist and do not yet: `/passport` (index), settings inside the profile, `/admin/reports`, `loading.tsx` / `error.tsx` / `not-found.tsx`. `/chat` demotes from a tab to affordances on Home, the bottle page and Explore.

---

## 12. Decisions

Supersedes the old open-questions list; SOCIAL.md §14's decision table is incorporated by reference.

| Decision | Status | Rationale / how to overturn |
|---|---|---|
| Rating scale | **Decided:** half-stars 0.5–5.0 stored as a double; no 100-point mode planned | A 100-point display transform is possible later without a storage change |
| Platform | **Decided:** Next.js + Capacitor; iPhone polished first, both built in CI | NATIVE_APP.md §1.4 tripwires |
| AI provider | **Decided:** runtime selection, OpenRouter preferred when configured; ids in code | Revisit if caching/web-search loss on OpenRouter costs more than its convenience |
| Embeddings / semantic search | **Deferred** behind a search evaluation | Unfreezes per §5.4 |
| App name and bundle id (`com.whaikey.app`) | **Open — decide before any store record exists** (irreversible on both stores). Also blocks the Universal/App Link auth callback, which needs association files naming a real team id and bundle id (NATIVE_APP.md §2.3) | Owner |
| Production domain (`app.whaikey.com` assumed) | **Open** | Owner; blocks deep links, OAuth redirect, `.well-known`, shell URL |
| Reviewer/demo access under social-login-only | **Open** | Options: env-flagged review-only credential provider bound to one fixed account; a signed long-lived reviewer link; a guest mode. Conflicts with AGENTS.md's password rule, so it needs an explicit owner call |
| Palate card provenance (review SEC-M7) | **Open** | Preferred: social projections exclude "Only me" pours; else state the aggregation in SOCIAL §7.1 and the UI |
| Community segment on `/bottles/[id]/compare` before the jurisdiction review | **Open** | Keep behind a flag, or roll back until reviewed |
| Whiskey School progress server-side | **Recommended: yes** | One day of work; needed for any gating or passport tie-in |
| Social phase gating | **Decided:** no S3 remainder or S4 until S1/S2 overlap numbers are published and §12 metrics exist | SOCIAL.md §15 |
| Whole-shelf sharing timing; jurisdiction checklist before S4 | **Open** (SOCIAL §14) | As before |

# Whaikey — Data Sourcing Strategy

Companion to [PLAN.md](../PLAN.md), [FEATURES.md](./FEATURES.md), and [COMPETITORS.md](./COMPETITORS.md). Based on live web research (July 2026). Items marked *(unverified)* couldn't be confirmed against a primary source. For scaling the enrichment/verification pipeline to the full ~25k-bottle backlog and the July 2026 sweep of additional sources/datasets, see [SOURCING_AT_SCALE.md](./SOURCING_AT_SCALE.md).

**TL;DR:** There is no single whiskey API — that's *why* the competitor field is fragmented. But a surprisingly strong catalog can be assembled almost entirely from **free, legally clean sources**: the US TTB label-approval registry (labels + images + barcodes), Iowa's open liquor dataset (clean SKU catalog + prices), Wikidata (distilleries, CC0), and control-state price books — then layered with affiliate feeds (live prices + revenue), a free auction-trend API, and user contributions as the long-term moat.

---

## 1. The recommended stack

```
CATALOG SEED (free)          SCAN-TIME RESOLUTION         PRICES                        IMAGES/SCANNING
──────────────────           ────────────────────         ──────                        ───────────────
TTB COLA registry     ──▶    Own DB first                 Iowa dataset (baseline)       COLA label images
Iowa Products dataset        ↓ miss                       Control-state price books     Affiliate feed images
Wikidata distilleries        UPCitemdb (fallback)         Affiliate feeds (live+$$)     User photos (the moat)
86-distillery flavor DS      ↓ miss                       Whisky Hunter (auction trend) Vision: barcode-first →
User submissions             Open Food Facts (fallback)   Wine-Searcher/Whiskystats     OCR → visual match
                             ↓ miss                       (licensed, when funded)       (TinEye WineEngine /
                             Photo + OCR → grow own DB                                   Vuforia, COLA-seeded)
```

---

## 2. Bottle catalog sources

### 2.1 TTB COLA Public Registry ⭐ — the free US backbone
Every US Certificate of Label Approval since 1999: brand name, fanciful name, class/type ("straight bourbon whisky"), origin, applicant, approval date, status, **and the label images themselves**. New approvals appear ~48h after issuance.

- **Access:** free public search UI + CSV-style extract downloads (no full official bulk dump/API). Commercial repackager **COLA Cloud** offers 2.9M+ records, **5M+ label images, 575k+ extracted UPC/EAN barcodes**, AI-extracted ABV/volume, via REST/bulk (~2,500 new approvals/week); pricing by contact *(unverified)*. **Implemented:** `pnpm ingest cola --since <date>` (src/lib/ingest/cola.ts) pulls whisky-class approvals via the documented public-search → Save-Search-Results CSV flow, month-chunked around the 500-row cap. Names + categories only (no ABV/price/UPC on COLAs). The registry has scheduled maintenance windows (Sundays) during which it returns 503.
- **Licensing:** US government public record — free, no copyright on the records. Label *artwork* copyright stays with brands; identification use is standard industry practice but **get counsel review** before bulk redistribution.
- **Gotchas:** COLAs are label approvals, not products — one bottle can have many COLAs and some approved labels never ship (needs a dedupe/clustering pipeline). US-only. No prices.

### 2.2 Iowa Liquor open data ⭐ — clean US SKU catalog + price baseline
- **Iowa Liquor Products** dataset: a clean product catalog — item number, description, category, vendor, proof, identifiers, list prices. Ideal seed for mainstream US brands.
- **Iowa Liquor Sales** dataset: ~30M+ wholesale purchase rows since 2012 with **state bottle cost and state bottle retail**, store geography, volumes. Monthly updates.
- **⚠️ Platform migration (July 2026):** data.iowa.gov moved off Socrata to the new **Iowa Data Hub**; the old `/resource/<id>.json` SODA endpoints are dead. Products now downloads from `https://idh-be.iowa.gov/api/v1/datasets/1029/rows.json` (a ZIP containing NDJSON; CC-BY 4.0). **Implemented:** `pnpm ingest iowa` (src/lib/ingest/iowa.ts) syncs the whiskey categories into the catalog — names, ABV, 750ml state retail price, and UPCs — deduped against the curated seed.
- **Gotchas:** Iowa assortment only (mainstream; few imports/allocated bottles); names carry program noise (barrel-pick/allocation prefixes, "Mini"/"PET"/"DISCO" suffixes — handled in src/lib/ingest/normalize.ts); category buckets are shelving, not taxonomy (Japanese malts under "Scotch Whiskies"); wholesale-oriented pricing.

### 2.2b Additional retail catalogs — Oregon, Utah, BC, Systembolaget, Vinmonopolet
**Implemented** (July 2026, from the SOURCING_AT_SCALE.md research): `pnpm ingest oregon|utah|bc|systembolaget|vinmonopolet`, all flowing through the same `ingestCandidates` matching (curated catalog always wins; imported rows only add what's missing).

- **Oregon OLCC** (src/lib/ingest/oregon.ts) — state open-data CSV, latest monthly snapshot only: names, categories, age, ABV, 750ml shelf price. ~1k whiskey candidates.
- **Utah DABS** (src/lib/ingest/utah.ts) — fiscal-period XLSX discovered from the product-list page (URL changes each period): names, categories, 750ml price. No ABV/UPCs.
- **BC Liquor** (src/lib/ingest/bc.ts) — monthly CSV resolved via the BC Data Catalogue CKAN API (Open Government Licence — BC): names, categories, ABV, and **real product barcodes** (0.75 L container only, same rule as Iowa). Prices are CAD and not imported.
- **Systembolaget** (src/lib/ingest/systembolaget.ts) — via the C4illin/systembolaget-data community mirror (~2k whisky rows, European/Scotch coverage, ABV). Prices are SEK and not imported; per §2.6 this is an enrichment source only, never a hard dependency. The mirror's numeric "taste clock" fields are a future enrichment input.
- **WHISKY:EDITION** — *removed Oct 2026* (domain lapsed in Sept 2026, TLS refused from Oct). Bottles it imported earlier stay in the catalog (factual metadata only; CC BY 4.0 attribution to WHISKY:EDITION still applies to them).
- **Vinmonopolet** (src/lib/ingest/vinmonopolet.ts) — official Norwegian monopoly developer API (free key → `VINMONOPOLET_API_KEY`). The sanctioned products API has been **slimmed to names only** (no category/ABV/price), and its name filter accepts single words only — the adapter unions whisky-signal terms (~1k products) and infers conservative name-cue categories (no-cue rows land as "world" for enrichment to refine). Value: European name coverage + "sold at a state monopoly" evidence for §2.4b verification.

### 2.3 Wikidata / DBpedia — distillery reference layer
Distilleries with country, region, owner, founding date, coordinates, photos. **CC0 (no attribution needed)** via SPARQL. Good for notable distilleries worldwide; weak on craft/new ones and bottle-level data. Use for distillery pages (map, history), not the catalog.

### 2.4 Flavor profiles for the bulk catalog — tiered enrichment
Bulk-ingested bottles (Iowa/COLA) arrive without flavor profiles, so recommendations skip them. **Implemented:** `pnpm ingest enrich` (src/lib/ingest/enrich.ts) fills 8-wedge profiles in tiers: (1) bottles with ≥2 tagged user tasting notes roll up directly from the notes — free, and community truth always wins; (2) the rest go to a Claude model (`WHAIKEY_ENRICH_MODEL` to override) in batches with catalog description + user-note snippets as context. `OPENROUTER_API_KEY` is preferred; `ANTHROPIC_API_KEY` remains a direct-provider fallback. Direct Anthropic enrichment uses its hosted web search tool by default; OpenRouter's compatible Messages endpoint runs this flow without that Anthropic-specific tool, retaining catalog context and model knowledge. Profiles only — no AI-generated descriptions or facts (product guardrails). The `catalog sync` GitHub workflow (.github/workflows/catalog-sync.yml) runs iowa → the §2.2b secondary sources (oregon, utah, bc, systembolaget, whiskyedition, vinmonopolet — each best-effort) → cola → enrich against the production DB weekly and on demand; Vinmonopolet needs the `VINMONOPOLET_API_KEY` repo secret and is skipped without it. **Health (Oct 2026):** every source writes a summary (`pnpm ingest <source> --summary FILE`) and `scripts/catalog-sync-report.ts` rolls them up — counts per source and deltas vs the previous run — into the step summary and the `catalog-sync-summary` artifact. 0 candidates from a source fails the run (`--allow-empty` exempts short COLA windows); a source serving HTML instead of data is `degraded` (green with warning). Scheduled runs open/comment on a `catalog-sync` issue when not healthy and close it on recovery. Enrichment runs on the schedule too, `--no-web` and capped by the `CATALOG_ENRICH_LIMIT` repo variable (default 100 bottles; 0 disables).

### 2.4b Bulk "actually sold" verification — durable queue + worker execution
Iowa/COLA-imported bottles are label approvals or wholesale SKUs, not proof a consumer product ever shipped — `bottles.status = "imported"` means unverified. **Implemented:** `pnpm verify-sold` (scripts/verify-sold.ts) runs a durable, subscription-only queue (src/lib/ingest/verification-queue.ts): `--dry-run` previews what a snapshot would enqueue (no writes, no Claude calls); `--apply` snapshots imported bottles into per-bottle work rows, then a bounded in-process worker pool (src/lib/ingest/verification-worker.ts, ≤4 concurrent workers) claims leased batches and asks an authenticated Claude Code CLI subscription — never an API key — to confirm each bottle against a real (non-TTB) product page. Every claimed id gets exactly one durable outcome: source-backed evidence promotes the bottle (`src/lib/ingest/verify-sold.ts`'s `persistSoldVerification`) and marks the work row `verified`; an explicit "not sold" answer is durably `not_evidenced` (the bottle stays `imported` and is never re-selected, unlike a naive repeated `status=imported` scan); malformed/missing/duplicate answers and CLI failures bound-retry with backoff before landing on `failed_terminal`. A tiny structured-output smoke probe runs before every `--apply` to catch a logged-out CLI before any lease is claimed. `--report`/`--resume <run-id>` recompute the same seven-field checkpoint (scanned/leased/verified/not_evidenced/retryable/rejected/errors) from durable state, so a crashed invocation is safe to inspect or continue.

### 2.4c Source-backed product and editorial resource graph

Automation and the issue-driven feedback loop are documented in [SUBSCRIPTION_CATALOG_AUTOMATION.md](./SUBSCRIPTION_CATALOG_AUTOMATION.md). The scheduled manifest scan is deterministic and model-free; subscription-backed AI only discovers bounded candidate URLs, which still pass through this parser and its provenance rules.

**Implemented:** `pnpm ingest resources --manifest <file>` parses a curated manifest of exact bottle-to-page matches. It is a dry run unless `--apply` is supplied. The adapter prefers JSON-LD (`Product` / `Review`) and OpenGraph metadata, stores atomic claims with their source URL and retrieval timestamp, and never retains article/review bodies. Official product pages may fill only missing canonical fields and may promote `imported → verified`; editorial pages remain corroborating links and cannot promote or overwrite a bottle. TTB pages are rejected as official product evidence.

Source and image policy are explicit per manifest entry:

- `structured` fetches bounded metadata (2 MB streamed limit, four concurrent fetches by default, HTTPS-only, origin-locked redirects, DNS validation with a pinned public address); `link_only` records an outbound resource without crawling it.
- `display_remote` permits a remote image to render with attribution; `link_only` and `review_required` media are retained as provenance but never rendered.
- Stored claims become compact `sourceFacts` for flavor enrichment. Bottles with source facts are removed from the hosted web-search budget, so the LLM formats/synthesizes already-cited evidence instead of researching the product again.

Start with `config/catalog-resource-manifest.example.json`; the respected-source policy registry is in `config/catalog-sources.json`. Exact official producer domains are operator-curated in each manifest rather than guessed by the model.

#### 2.4a Tiered backfill on the Codex subscription (Oct 2026)
`pnpm flavor` (scripts/flavor-enrich.ts, src/lib/ingest/flavor-tiers.ts) supersedes the capped API-key enrich step for the backlog. Three passes, in order:
1. **free** — community roll-up (≥2 tagged user notes; always wins over estimates) and a keyword pass: producer/critic/user leaf tags plus `matchLeafIds` over the catalog description, critic notes and user note text, rolled up to wedges. Needs ≥3 leaves across ≥2 wedges. Tier `keyword`, confidence 0.3–0.4. Re-runs only when the inputs hash changes.
2. **cheap** — `gpt-6-luna` (low reasoning), no tools, 25 bottles/request, for bottles still missing a profile. Tier `model`, 0.5. User notes are never sent to the model.
3. **heavy** — `gpt-6.1-sol` with web search, 5 bottles/request, for the top-N most popular bottles (popularity score, 2.4d) below `model_web`, including untracked legacy profiles inside the top set. Tier `model_web`, 0.75 — only when the answer cites at least one public https source for that bottle; an uncited answer is recall and is stored at tier `model` (and can't replace a legacy profile).

Every write records `bottle_flavor_provenance` (tier, confidence, method/model, pass, date) and lands only over an equal-or-lower tier (guard in SQL). Profiles with no provenance row predate tracking (seed / old enrich, "legacy") and are only replaced by a `model_web` write for a bottle in the top popularity set that is not a user submission and has no tasting notes (the old enrich rolled up/prompted with user notes); the replaced profile is kept in `bottle_flavor_provenance.replaced_legacy_profile`. Whether a write may replace legacy is decided by `apply` from the live ranking, never by the results file. Model output is validated (exact 8 wedge ids, integer 0-10, ids from the exported batch).

**Where it runs.** The DB secret stays in GitHub (`.github/workflows/flavor-enrichment.yml`: `prepare` = free pass + export, `apply` = validate + write, `coverage`); the Codex login stays on the Hermes host (`scripts/flavor-codex-bridge.py`, run by a Hermes cron job). Raw model text crosses via assets on the `flavor-enrichment-data` prerelease. The bridge reads `hermes usage --json` before the run and before every request and stops a pass at 48% used of any window, so at least half the subscription window is always left; the next run resumes from whatever is still missing. Failures open/comment a `flavor-enrichment` issue. The CLI never runs drizzle migrations (it creates its table with idempotent DDL matching migration 0050), so it is safe to dispatch from a branch.

#### 2.4c In-app enrichment on Vercel with an API key (Oct 2026)
The production path. Runs inside the app's Vercel functions on an API key (src/lib/enrich/*); it never uses the Codex subscription or a host worker. **Inert until configured:** nothing calls a model unless `ENRICH_ENABLED=true` AND a provider key is present.

- **Providers** (`ENRICH_PROVIDER` = `auto` | `openai` | `anthropic`, default `auto`: OpenAI when `OPENAI_API_KEY` is set, else the existing `ANTHROPIC_API_KEY`). Quick profile: `gpt-6-luna` (low reasoning, no tools) / `claude-haiku-4-5`. Web notes: `gpt-6.1-sol` + hosted `web_search` / `claude-sonnet-5` + hosted web search, ≤3 searches. Overrides: `ENRICH_OPENAI_QUICK_MODEL`, `ENRICH_OPENAI_WEB_MODEL`, `ENRICH_OPENAI_REASONING`, `ENRICH_ANTHROPIC_QUICK_MODEL`, `ENRICH_ANTHROPIC_WEB_MODEL`.
- **Live new-bottle jobs.** `POST /api/bottles` queues a `bottle_enrichment_jobs` row (per submitter: 10/hour, 30/day; beyond that the daily batch covers it) and runs the first step in `after()`. Steps: keyword (free) → quick model → web model, **one model call per invocation** (Hobby `maxDuration` 60 s); each later step is kicked by the bottle page's poll (`GET /api/bottles/:id/enrichment?after=<seq>`, also via `after()`), and a 90 s lease makes overlapping kicks harmless. Every step writes `bottle_enrichment_events`; the bottle page's "Building this bottle's card" panel polls them (2 s while running, 10 s while parked).
- **Same rules as 2.4a:** user notes are never sent; replies are validated (exact wedge ids, integers 0–10, our bottle id); profiles go through `writeTieredProfiles` (never over a higher tier or community notes; over a legacy profile only for a sourced refresh of a top-popular bottle); a web answer without a cited https source is stored at tier `model`, and notes/details are kept only with a source. Details (ABV, age, casks, mash bill, country) fill only empty columns (`coalesce` in SQL), so user-entered values are never replaced. Notes show on the bottle page labelled "AI summary of published notes" with the sources linked.
- **Spend control.** Each call first **reserves** its worst-case estimate (a pending `enrichment_calls` row written under a transaction-scoped advisory lock), so concurrent calls can't overrun the cap; the real usage replaces the reservation, and a failure with unknown usage keeps the estimate. Every call is logged to `enrichment_calls` (tokens, searches, latency) and to `ai_usage` (feature `enrich`); `$` is estimated from `src/lib/ai/usage.ts` rates. Before each call the gate checks pause and the **daily cap (hard stop, default $2/UTC day)** against today's spend plus that call's worst-case estimate; a blocked job parks for 10 min and reads "Queued — we'll finish this soon".
- **Scheduled + operator runs.** `/api/cron/enrich` (vercel.json, daily 04:00 UTC; `CRON_SECRET`) runs 55 s chunks of tiers queue → keyword (free) → missing (25 bottles per quick call, resumable via `enrichment_settings.missing_cursor`) → web (the top 2,500 bottles by popularity, 2.4d, still below `model_web` — including legacy profiles — re-checked after 30 days), and chains itself up to 12 chunks while a chunk stops for time. `/admin/enrichment` (operators only): provider status, coverage by tier, queue, recent runs, tokens + $ per day and per run, daily cap, pause/resume, "Run batch now" by tier, retry failures, per-bottle re-enrich.
- **Estimated cost per bottle** (≈1k input / 300 output tokens quick; ≈6–10k input incl. search results / 600 output + ≤3 searches web): OpenAI quick ≈ $0.0003, web ≈ $0.02–0.05 incl. $0.01/search; Anthropic Haiku quick ≈ $0.0025, Sonnet web ≈ $0.04–0.07 incl. $0.01/search. A full live bottle ≈ $0.02–0.05 (OpenAI) / $0.05–0.08 (Anthropic); the batch quick tier ≈ $0.0003–0.002 per bottle. $2/day ≈ 40–100 web-researched bottles.
- **Retiring the legacy bulk path.** The host Codex bridge (2.4a, Hermes cron `079cd3d98611`) stays in place until this path is keyed and has covered the backlog; then disable the cron and the workflow's schedule. Don't delete it before then.

#### 2.4d Popularity: what gets refreshed first (Oct 2026)
`src/lib/popularity.ts` ranks bottles by **20·pours + 10·shelf/wishlist rows + 5·scan matches + 3·search appearances + 1·page opens** (last 90 days) **+ 2·retail feeds listing it + 1·has a barcode**. Searches, opens and scans are anonymous per-bottle daily tallies in `bottle_popularity_daily` (no user, session, IP or query text; capped at 50 per counter per bottle-day; obvious bots skipped; swept after 90 days with the rest of the telemetry): `/api/bottles/search` counts the first 3 results of a ≥3-character query, the bottle page counts an open, `/api/scan/upc` counts the bottle a barcode resolved to. The top `POPULAR_REFRESH_TOP` (2,500, user submissions excluded) is the set whose legacy profiles may be refreshed — by the in-app web tier (2.4c, within the $ cap) and by the Codex heavy pass (2.4a, `--heavy-top 2500`). `/admin/enrichment` shows the top 10 with their signals, daily spend vs the cap and profiles written per day by tier (30 days), and month-to-date spend.

### 2.5 Open flavor datasets — recommendation bootstrapping
- **Classic 86-distillery Scotch dataset**: 86 single malts scored 0–4 on 12 flavor dimensions — small but perfect for bootstrapping flavor-similarity before we have user data.
- WhiskeyProject/whiskey-api (~370 whiskeys, ~70 flavor tags), 2.2k scraped Whisky Advocate reviews (⚠️ copyright risk if surfaced verbatim — use for internal priors only, if at all).

### 2.6 What we can NOT build on
- **Whiskybase** — no official API; undocumented private API serves their own app; scraping is legally risky and would poison the well for a future partnership. The right move long-term is a **licensing conversation**, not a scraper.
- **Vivino/Distiller data** — closed.
- **Systembolaget & LCBO** — cautionary tales: both retailers *revoked* previously open product APIs (Systembolaget explicitly to prevent commercial alcohol promotion). Never build a core feature on a single third-party feed.

---

## 3. Barcode resolution

Order of resolution at scan time:

1. **Own DB** (seeded from COLA Cloud barcode extractions + Iowa identifiers + **BC price-list barcodes** + crowd-verified user confirmations).
1a. **Pending crowd claims** (`upc_confirmations`, `src/lib/upc-crowd.ts`). An unknown barcode the user resolves by picking a bottle becomes a *pending claim*, not a mapping. It is published to `bottle_upcs` when `WHAIKEY_UPC_CONFIRMATIONS_REQUIRED` (default 3 — owner decision 2026-10-25) eligible accounts agree with a 2:1 lead over any competing claim, when a trusted account confirms it (an operator, or an account ≥30 days old with ≥5 claims borne out and none rejected), or when an operator approves it at `/admin/catalog/barcodes`. Eligible means not suspended and older than 7 days. Each account gets one claim per barcode and at most 25 new pending claims a day. The scanner's own pending claim resolves for them immediately, and other people's claims are offered as suggestions before any provider is asked.
2. **Whiskey-specialized provider** (optional, env-configured `WHAIKEY_WHISKY_UPC_URL`/`_KEY`) — a licensed spirits API such as WhiskyDB's per-license endpoint, tried before the generic catalogs because spirits-aware data beats them on whiskey. Skipped when unset.
3. **UPCitemdb** — 715M+ claimed UPCs; free 100 req/day, Dev $99/mo (20k/day). Best volume-per-dollar. The paid `/prod/v1` endpoint is used when `UPCITEMDB_KEY` is set, otherwise the trial.
4. **Open Food Facts** — free, no key, but spirits coverage is thin and **ODbL share-alike licensing** means we must NOT merge OFF data into our proprietary DB (use as transient lookup only; consider contributing user scans back as goodwill).
5. **Miss → photo + OCR flow** that grows our own DB (every miss is a data-acquisition event).

**Provider guards (`src/lib/upc-providers.ts`).** Every provider answer, hit or miss, is cached in `upc_lookup_cache`. A hit is kept permanently (OFF for 30 days) and a miss for 7–30 days, so a barcode costs at most one request per provider. The cache is isolated: it is never merged into `bottles`/`bottle_upcs`, and titles are only used to fuzzy-search our catalog. `upc_provider_usage` meters requests per UTC day and per minute. The UPCitemdb trial defaults to 95/day and 5/min (`WHAIKEY_UPCITEMDB_DAILY_BUDGET`, `WHAIKEY_UPCITEMDB_PER_MINUTE`), under its 100/day and 6/min cap. A 429 or 5xx sets an exponential backoff that honours `Retry-After`/`X-RateLimit-Reset`; a 429 on a capped provider backs off to the next UTC midnight. A spent or backed-off provider is skipped, never failed: the scan falls through to the next provider, then to search or "add this bottle". Kill switches: `WHAIKEY_UPCITEMDB=off`, `WHAIKEY_OPENFOODFACTS=off`, and `WHAIKEY_UPC_LOOKUP=off` for all providers. `/admin/scan` shows today's requests against budget, the backoff state and the cache size.

Alternatives: Go-UPC ($74.95/mo for 5k req/mo, explicitly advertises liquor coverage), Barcode Lookup (~$99–999/mo *(unverified)*).

**Whiskey-specific gotchas:** the same UPC is reused across proofs/years/batches (a 2015 and 2023 release share a barcode — our batch/variant model must layer on top); allocated releases are often missing entirely; UPC API ToS generally **prohibit bulk-seeding a permanent database** — respect cache windows, and treat user-confirmed matches (our own first-party data) as the thing we keep.

---

## 4. Price & market data

### 4.1 Free & legally clean (launch tier)
- **Iowa dataset** — monthly baseline of cost/retail for mainstream US SKUs.
- **Control-state price books** (~17 states publish real retail prices): Virginia ABC (Excel downloads ⭐ easiest), North Carolina (quarterly uniform price list), Pennsylvania PLCB (quarterly, PDF — needs parsing), Ohio OHLQ (JSON-backed site, ~4k SKUs incl. per-store availability), plus NH, UT, MI, OR *(formats unverified)*. Different item codes per state — entity matching to our canonical catalog is the real work.
- **Whisky Hunter API** — free, no-auth JSON aggregating **28 whisky auction sites**: per-distillery and per-auction time series (GBP, sold lots only). Distillery-level granularity, not per-bottle; commercial-reuse terms unclear *(unverified — confirm before launch)*. Powers "market trend" charts cheaply.

### 4.2 Commercial (when funded)
- **Wine-Searcher API** — confirmed to cover spirits; returns min/avg/max retail price worldwide + offers. 100 free calls/day trial; paid tiers by contact (historically $hundreds–thousands/mo *(unverified)*). The de facto standard for "what does this cost at retail."
- **Whiskystats Whisky Data API** — global catalog + millions of auction records + indices; the auction-value authority (Whiskybase itself references them). Pricing by contact.
- **Rare Whisky 101** — indices + valuation *services*, no API found; not a feed.

### 4.3 Affiliate feeds — prices + images + revenue in one motion
- **The Whisky Exchange** (Awin, merchant 400), **Master of Malt** ("bespoke mapped product feeds"), **Total Wine** (FlexOffers/CJ, XML feeds, 2–8% commission). SMWS and others also on networks. (Drizly is dead — Uber shut it March 2024.)
- Feeds include name, SKU, live price, image, deep link — licensed **for driving referral traffic**, not for building a general price DB; images licensed for affiliate display only. Within those terms: live retail prices for popular bottles + our first revenue stream (COMPETITORS.md §7 affiliate decision).

### 4.4 Honest-valuation implications (ties to COMPETITORS.md §2.7)
Given the 2024–25 secondary-market correction, our "collection value" = **range + trend + source-labeled estimate**, assembled from: user's own purchase price → state retail lists → affiliate live prices → auction trend (Whisky Hunter/Whiskystats). Never a single overconfident number.

---

## 5. Label scanning & images

### 5.1 Reference image sources
1. **TTB COLA images** — the only bulk source of US spirits label imagery (5M+ via COLA Cloud). Approval scans, sometimes low-res/flat artwork; counsel review for redistribution posture.
2. **Affiliate feed images** — clean product shots, affiliate-display license only.
3. **Brand press kits** (Diageo, Pernod, Beam Suntory, Sazerac media portals) — editorial-licensed bottle shots; doesn't scale to the long tail.
4. **User photos** ⭐ — the scalable path and the eventual moat (Vivino's playbook): ownership/license assigned via our ToS; every scan improves the corpus.

### 5.2 Recognition pipeline (matches FEATURES.md §2.2)
- **Barcode-first** (what BAXUS and Distiller actually do — cheap, reliable), then:
- **OCR text match** — spirits labels are text-heavy (brand, age, proof all printed); cloud Vision OCR or on-device OCR + fuzzy match against our catalog is a cheap, strong first visual pass; also the natural fallback UX ("we read 'Laphroaig 10' — is this it?").
- **Visual label matching** for the hard tail: **TinEye WineEngine** (explicitly supports spirits; you supply the reference label DB — COLA images slot in perfectly) or **PTC Vuforia Cloud Recognition** (Vivino's proven stack). Google Cloud Vision Product Search as the commodity alternative (~$4.50/1k queries *(unverified)*).
- **Every user correction is stored** as eval/training data — the correction loop is how scan accuracy compounds (and how The Daily Pour's crashing scanner becomes our cautionary benchmark, not our fate).

### 5.3 What competitors use *(unverified)*
BAXUS/BoozApp: UPC-first against their 55k+ barcode DB. Distiller: barcode scanner. Bottle Raiders/Daily Pour: markets AI image recognition (reliability problems noted in COMPETITORS.md §2.5). Vivino: Vuforia cloud recognition at millions-of-targets scale.

---

## 6. Build plan & costs

| Phase | Action | Cost |
|---|---|---|
| 0 | Seed catalog: Iowa Products + Wikidata + 86-distillery flavor data; dedupe/normalization pipeline | $0 + eng time |
| 0 | Evaluate COLA Cloud vs. self-extracting TTB (barcodes + images are the decision drivers) | quote *(TBD)* |
| 1 | Barcode scan: own DB + UPCitemdb free tier → Dev ($99/mo) as volume grows | $0→$99/mo |
| 1 | Price baseline: Iowa monthly sync + VA/NC/OH state price book parsers | $0 |
| 2 | Label scan: OCR-first pipeline; pilot TinEye WineEngine seeded with COLA images | OCR ~pennies; TinEye quote |
| 2 | Affiliate onboarding: Awin (TWE), Master of Malt, Total Wine — feeds + first revenue | $0 (rev-positive) |
| 3 | Auction trends: Whisky Hunter integration (confirm terms); Whiskystats/Wine-Searcher conversation when funded | $0 → licensed |
| 3+ | Whiskybase partnership conversation (licensing, not scraping) | TBD |

### Legal checklist (before launch)
- [ ] Counsel review: COLA label-image redistribution posture.
- [ ] ODbL isolation: Open Food Facts data never merged into proprietary DB.
- [ ] UPC API ToS compliance: caching windows, no bulk seeding.
- [ ] Affiliate feed usage stays within referral-traffic license; feed images flagged in our media store with license metadata.
- [ ] Whisky Hunter commercial-use terms confirmed.
- [ ] Our ToS: user-photo license grant + community-contribution terms (opt-in, per PLAN.md privacy stance).
- [ ] Scraped review datasets (Whisky Advocate etc.) excluded from user-facing surfaces.

### Single-source risk rule
Every externally-fed feature must have a degraded-but-working mode if the source disappears (Systembolaget/LCBO precedent): prices fall back to user-entered + state lists; scanning falls back to search; trends fall back to our own community data. First-party data (user bottles, pours, corrections, prices-paid) is the only foundation we fully control — **every design decision should convert third-party lookups into first-party records.**

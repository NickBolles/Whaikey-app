# Whaikey — Sourcing at Scale (25k-bottle enrichment research, July 2026)

Companion to [DATA_SOURCES.md](./DATA_SOURCES.md). Based on live web research (2026-07-27); items marked *(unverified)* couldn't be confirmed against a primary source. Scope: with ~25,000 catalog bottles awaiting enrichment/verification, (a) how do we make the pipeline dramatically faster and cheaper, and (b) what sources/datasets exist beyond the ones already in DATA_SOURCES.md?

**TL;DR:** The current pipeline is architecturally serial — `pnpm ingest enrich` runs one model call at a time and `verify-sold` is capped at 4 CLI workers, so 25k bottles is multi-day work. The fix is not more workers: the Anthropic **Message Batches API** now supports the web search tool *and* structured outputs, at a 50% discount, with up to 100k requests per batch — both the flavor-profile job and the sold-verification job fit in one batch each and typically complete within an hour. Combined with dedupe-first + embedding propagation (which removes 30–50% of the work before any model call), the whole backlog is a **~$150–400, same-day job instead of a multi-day drip**. Separately, research surfaced ~15 new usable sources (Oregon/Utah/BC open price data, Norway's official Vinmonopolet API, Sweden's taste-clock mirror, the WhiskyAnalysis meta-critic sheet, the Reddit review archive, the TTB permittee list) worth wiring into ingest.

---

## 1. Where the time actually goes today

| Stage | Implementation | Throughput | 25k-bottle wall clock |
|---|---|---|---|
| Flavor enrichment (web on) | `enrichBottleProfiles` — **strictly sequential** batches of 10, one `messages.create` (+ up to 10 hosted web searches, `pause_turn` continuations) at a time | ~10 bottles / 60–90 s | **~2–3 days**, single lane |
| Flavor enrichment (`--no-web`) | Sequential batches of 25 | ~25 bottles / 15–30 s | ~4–8 h |
| Sold verification | `verify-sold` queue → ≤ `MAX_WORKERS = 4` in-process workers, 5 bottles per Claude Code CLI call, 180 s timeout | ~5,000 CLI calls | **~30–80 h** at the cap |

Structural issues, in order of impact:

1. **No request concurrency in enrich.** The batch loop (`src/lib/ingest/enrich.ts`) awaits each model call before starting the next. Everything else is dwarfed by this.
2. **Interactive API for a bulk job.** Every bottle pays synchronous pricing and rate limits for work that has no latency requirement.
3. **Web search coupled to generation.** Up to one hosted search per bottle (~$10/1k searches ⇒ ~$250 across the backlog) forces the slow agentic path even for bottles the model already knows.
4. **No dedupe/propagation before the model.** Iowa/COLA imports are heavy with size/proof/label variants of the same expression; each variant is currently a separate model call.
5. **CLI-loop verification.** `verify-sold` deliberately trades throughput for durability + subscription auth. Fine as a design, but it's the wrong tool for a 25k backlog when the same web-grounded check can run inside a batch.

## 2. The speed plan

### 2.1 Move bulk enrichment to the Anthropic Message Batches API ⭐

Verified against the platform docs (2026-07-27):

- GA, all active models; up to **100,000 requests or 256 MB per batch** — the whole backlog fits in one batch per job.
- **50% off input and output tokens**; most batches complete **within 1 hour** (24 h hard expiry; expired requests unbilled).
- **All server tools work in batches — including web search** — and **structured outputs** (`output_config.format` + JSON schema) work too. This is the load-bearing fact: it batches not just the offline tier but the web-grounded tier *and* sold-verification.
- **Prompt caching stacks with the batch discount** (cache read = 0.1× base input, then ×0.5). Use the 1-hour TTL and a byte-identical prefix (wedge guide + instructions first, per-bottle rows last). Hit rates in batches are best-effort (30–98%).

Pipeline shape: keep tier 1 (community-note roll-ups) as is → dedupe/propagate (§2.3) → submit the residue as one batch (one request per ~5–10 bottles, ids echoed in a schema-enforced output array) → poll, reconcile by `custom_id`, re-run failures individually. The existing durable-queue pattern from `verification-queue.ts` maps cleanly onto batch submission/reconciliation.

Cost at Haiku-4.5-class with caching: **~$25–40** for all 25k profiles. Verification as a second batch with web search: ~$250 search fees + ~$95 tokens. **All-Anthropic total ≈ $370–390, ~2–4 h wall clock** — versus days of wall clock and open-ended agentic token burn today.

Cheaper variants if vendor flexibility is acceptable:
- **OpenAI Batch** (50k req/batch, 50% off): gpt-5.4-nano ≈ **$10** for all 25k profiles; structured outputs ride along in the request bodies *(support inferred, not stated on the batch page — unverified)*.
- **Gemini Batch** (50% off): Flash-Lite class ≈ **$4** *(limits/structured-output-in-batch unverified — official docs 503'd during research)*.
- **OpenRouter small models** (no batch/caching, self-managed concurrency): Qwen3-30B ≈ $3.70, gpt-5-nano ≈ $5.90 for the whole job. At these prices model *quality against the flavor-wheel ids* should drive the choice, not cost — run a ~100-bottle eval against `src/lib/flavor-wheel.ts` first.

### 2.2 Decouple search from generation for verification

The $250 hosted-search line item and the CLI loop both exist to answer "did this ship as a real product?" Cheaper, batchable alternative: raw search API → feed titles/snippets to a small model with a yes/no/unsure schema.

| Option | ~Cost for 25k lookups | Notes |
|---|---|---|
| Anthropic web search inside a batch | ~$345 all-in | One vendor, zero orchestration; kills the 4-worker cap outright |
| **Brave Search API + small-model judge** | **~$140** ($5/1k queries) | Cheapest verified path; search results are facts, model only classifies |
| Perplexity Sonar | ~$160 | Answer + citations in one call |
| Tavily / Exa | ~$175–190 | LLM-ready extracts / semantic search for obscure bottlings *(credit math unverified)* |
| Gemini grounding | ~$280 | $14/1k on Gemini 3.x *(aggregator-sourced; batch availability unverified)* |

Triage first: bottles already matched to a retail source (Iowa row, state price book, UPC hit, Vinmonopolet/Systembolaget listing) **are** evidence of sale — they need no web check at all. Cross-referencing the new price sources in §3 could remove a large fraction of the verification queue for free.

### 2.3 Shrink the work before any model sees it

- **Dedupe/cluster first.** Normalize (brand, expression, age, proof) and cluster variants; whiskey catalogs commonly shrink 20–40%. Every collapsed variant is a free enrichment *and* a free verification.
- **Embedding propagation.** Embed `name + distillery + category + age/proof` (text-embedding-3-small: ~**$0.03 total** for 25k bottles). Where cosine similarity to an already-profiled sibling from the same distillery/style is high (≥ ~0.9), copy/blend the 8-wedge profile and skip the model. Wedge profiles are distillery/style-correlated, so this is defensible for v1 estimates — but tag rows (`profileSource: "inferred"`) so the UI/concierge can distinguish them, and let community notes overwrite as always.
- **Batch-size guardrail.** Accuracy for entity-level batch extraction is stable up to ~8–16 items per call and degrades after; with prompt caching absorbing the shared-prompt cost, there's no economic reason to exceed ~10/call.

### 2.4 Quick wins in the current code (no re-architecture)

If a batch migration waits, two small changes buy ~10× today: run enrich batches through a bounded concurrent pool (8–16 in-flight requests) instead of the sequential loop, and split the run into an offline pass for everything + a web-grounded second pass only for low-confidence results. Neither changes any contract; both are consistent with the existing `onBatch` reporting.

## 3. New live sources (beyond DATA_SOURCES.md)

Verification labels: **verified** = fetched during research; *(search-verified)* = confirmed via current search results but fetch blocked; *(unverified)* as usual.

### 3.1 Government / monopoly catalogs — legally clean, bulk-friendly

- **Oregon OLCC Monthly Pricing** ⭐ verified — Socrata open data (`data.oregon.gov` export CSV/JSON): every spirit sold in Oregon with item code, description, size, proof, age, monthly price; updated July 2026. Same ingest shape as Iowa — near-zero effort.
- **Utah DABS product list** *(search-verified)* — full state inventory + prices, CSV/Excel export from the interactive product list.
- **BC Liquor product price list** *(search-verified)* — CSV under Open Government Licence–BC (SKU, name, category, size, price).
- **Vinmonopolet API (Norway)** ⭐ verified — official free developer portal (`api.vinmonopolet.no`): full monopoly catalog with names, categories, **ABV, producer, country/region**, prices, stock. Excellent European/Scotch coverage, sanctioned access.
- **Alko (Finland)** *(search-verified; fetch 403'd)* — documented daily price-list Excel: product code, name, producer, size, price, category, ABV (~700 whiskies).
- **Systembolaget via community mirror** verified — the official API is gone (see DATA_SOURCES.md §2.6), but `github.com/C4illin/systembolaget-data` / `AlexGustafsson/systembolaget-api-data` mirror the full catalog daily, including **structured "taste clock" flavor numbers (body/sweetness/smokiness), taste text, ABV, images**. One of very few open sources with numeric flavor data at catalog scale — great for wheel seeding. Legally murkier than the sanctioned APIs (mirror of a deliberately closed feed): use for internal enrichment, never as a hard dependency.
- **More control-state price books (PDF, parse quarterly/monthly):** Michigan quarterly price book, Idaho monthly listings, Alabama QPL, Vermont (802spirits) monthly list. West Virginia and New Hampshire: search-only, no bulk file. SAQ (Quebec): no open data — skip.
- **TTB FOIA List of Permittees** *(search-verified)* — 83k+ permit holders incl. all Distilled Spirits Plants (legal name, DBA, address), updated ~weekly, public domain. The authoritative **distillery/producer entity backbone** to join against COLA applicants and normalize distillery fields.
- **LCBO (Ontario):** official API long dead; `lcbo.dev` is an active third-party GraphQL API *(fetch bot-blocked)* and the LCBOstats historical price dataset (Dec 2022–May 2025, ~38k products with images/ABV/price history) is available from its author on request. Convenience sources only.

### 3.2 Community / editorial with structure

- **WhiskyAnalysis.com Meta-Critic Database** ⭐ — ~1,900 whiskies with normalized meta-critic score, review count, cost band, class, and **flavor cluster A–J** (extends the 86-distillery clustering to modern bottles). Embedded exportable Google Sheet, last updated Jan 2023. No formal license — email the author (Selfbuilt) before commercial use; treat as derived signal, don't redistribute. (The Kaggle mirror is dead — use the source sheet.)
- **Reddit Whisky Network Review Archive** ⭐ — public Google Sheet, tens of thousands of community reviews 2012–2023: bottle name, rating, region/style, **real price paid**, link to full review. Ideal for name canonicalization, popularity ranking, and price sanity checks.
- **TheWhiskeyJug WP REST API** verified — open WordPress endpoint (`/wp-json/wp/v2/posts`) with custom taxonomies (price, score, producer, distillery, region, type) + JSON-LD review schema. Use for facts/signals, not prose (copyright).
- **WHISKY:EDITION API** verified — purpose-built whisky API (`thewhiskyedition.com/developer`, Swagger + OpenAPI spec): metadata, tasting notes, collection data. Requires attribution; they ask for an email about use cases; pricing unpublished. The only whisky-specific API found that we don't already use — worth a 15-minute Swagger evaluation.
- **WhiskyDB / WhiskyyDB** verified — new (July 2026) aggregation of the same open sources we already use (COLA, OFF, Wikidata): 1,290+ bottlings, 3,200+ producers, auction benchmarks; free sample CC BY-NC, **cask + flavor taxonomies CC BY 4.0** (commercial OK), full dataset $49–99/mo. The free taxonomies are usable now; the paid tier is a make-vs-buy benchmark.
- **Ohio OHLQ:** robots.txt disallows `/api/` and blocks AI crawler UAs from some paths — crawl product pages via `sitemap-index.xml` HTML only, not the JSON API.
- **Seelbach's (Shopify)** — standard `/products.json` endpoint exposes craft-whiskey vendor, price, **barcode/UPC**, images; heavily rate-limited (429 at 1 req/min from a datacenter IP). Slow-crawl with backoff; check ToS. Caskers/ReserveBar/Flaviar have no equivalent.

### 3.3 Dead ends confirmed (don't spend time here)

BAXUS (hackathon API endpoint now 404s; no public API), EU e-label (no central registry), UK HMRC (wholesaler register only), Whisky Advocate (bot-blocked, no feed), Breaking Bourbon / Daily Pour (no structured feed), Connosr (frozen archive), auction houses directly (no APIs — Whisky Hunter already aggregates them, including Unicorn), Bottle Blue Book (HTML only; possible partnership target), data.world (community datasets retired July 2026).

## 4. New datasets (HF / Kaggle / GitHub / academic)

- **Kaggle koki25ando trio** *(pages live; details behind JS)*: **Japanese Whisky Reviews** (~1k reviews — fills our weakest coverage area), **World Whisky Distilleries & Brands** (global distillery list from whisky.com), **2,247 Scotch Whisky Reviews** (name, category, score, price, tasting text — overlaps our WA set; useful as a coverage cross-check).
- **`mhamilt/completely-smashed`** verified — Scottish distilleries as JSON/GeoJSON (name, owner, address, lat/lon), GPL-3.0. Ready-made geocoded layer for distillery pages.
- **HF `spacenship/whiskeyClassification`** verified-exists — 10k-row, **80.8 GB** image+text bottle dataset with train/val/test splits; no license, no dataset card. The only sizable whiskey label-image set found — potentially valuable for scan training, but provenance/licensing must be established before any use.
- **Sensory-lexicon paper (PMC8303687)** — 8,036 annotated whisky reviews (WhiskyAdvocate, WhiskyCast, TheWhiskeyJug, Breaking Bourbon); data on request from the authors only. The exact blueprint for our review→wheel extraction; also flags WhiskyCast as another review corpus.
- **Kaggle `rtatman/universal-product-code-database`** *(page live)* — ~1M UPC→name rows (general merchandise); filter for spirits as scan fallback. **UPC Data 4 Beverage Alcohol** (upcdata4spirits.com) *(unverified)* — commercial, alcohol-specialized UPC DB; pricing inquiry only if OFF coverage proves thin.
- **Zenodo/HF general sweep:** nothing else genuinely useful — most "whiskey" HF hits are robotics datasets; Whiskybase/Distiller remain scrape-only (ToS-restricted, per DATA_SOURCES.md §2.6 we won't).

## 5. Recommended sequence

| # | Action | Effort | Payoff |
|---|---|---|---|
| 1 | Dedupe/cluster the 25k + embedding propagation (`profileSource: "inferred"`) | ~1 day | 30–50% of all model work disappears; ~$0.05 cost |
| 2 | Port `enrich` to Message Batches (caching + structured outputs, offline tier) | ~1–2 days | 25k profiles ≈ $25–40, done in hours |
| 3 | Verification triage: retail-source cross-match counts as sold-evidence | ~1 day | Large slice of the verify queue closed with zero model calls |
| 4 | Residual verification as a web-search batch (or Brave + judge at ~$140) | ~1 day | Replaces the 30–80 h CLI loop |
| 5 | New ingest adapters: Oregon → Utah → BC (CSV, Iowa-shaped) | ~1 day each | Prices/proof corroboration + sold-evidence for triage |
| 6 | Vinmonopolet API + Alko Excel + Systembolaget mirror | ~2–3 days | European/Scotch coverage + numeric taste-clock flavor data |
| 7 | WhiskyAnalysis sheet (with permission) + Reddit archive join | ~1–2 days | Flavor clusters, ratings, real prices for the head of the catalog |
| 8 | TTB permittee list as distillery entity table | ~1 day | Producer normalization backbone |
| 9 | Email WHISKY:EDITION; evaluate WhiskyDB paid tier as make-vs-buy | hours | Optional accelerators |

### Legal checklist additions (extends DATA_SOURCES.md)
- [ ] WhiskyAnalysis: author permission before commercial use of meta-critic scores.
- [ ] Systembolaget mirror: internal enrichment only; no hard dependency; respect the retailer's closed-API intent.
- [ ] Seelbach's/Shopify: ToS review before crawling `/products.json`.
- [ ] `spacenship/whiskeyClassification`: establish provenance/licensing before any training use.
- [ ] OHLQ: HTML sitemap crawl only — `/api/` is robots-disallowed.
- [ ] WHISKY:EDITION: attribution requirement + written terms before integration.

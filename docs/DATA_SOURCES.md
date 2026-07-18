# Whaikey — Data Sourcing Strategy

Companion to [PLAN.md](../PLAN.md), [FEATURES.md](./FEATURES.md), and [COMPETITORS.md](./COMPETITORS.md). Based on live web research (July 2026). Items marked *(unverified)* couldn't be confirmed against a primary source.

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

- **Access:** free public search UI + CSV-style extract downloads (no full official bulk dump/API). Commercial repackager **COLA Cloud** offers 2.9M+ records, **5M+ label images, 575k+ extracted UPC/EAN barcodes**, AI-extracted ABV/volume, via REST/bulk (~2,500 new approvals/week); pricing by contact *(unverified)*.
- **Licensing:** US government public record — free, no copyright on the records. Label *artwork* copyright stays with brands; identification use is standard industry practice but **get counsel review** before bulk redistribution.
- **Gotchas:** COLAs are label approvals, not products — one bottle can have many COLAs and some approved labels never ship (needs a dedupe/clustering pipeline). US-only. No prices.

### 2.2 Iowa Liquor open data ⭐ — clean US SKU catalog + price baseline
- **Iowa Liquor Products** dataset: a clean product catalog — item number, description, category, vendor, proof, identifiers, list prices. Ideal seed for mainstream US brands.
- **Iowa Liquor Sales** dataset: ~30M+ wholesale purchase rows since 2012 with **state bottle cost and state bottle retail**, store geography, volumes. Monthly updates. Free via Socrata SODA API, CSV, and BigQuery public datasets.
- **Gotchas:** Iowa assortment only (mainstream; few imports/allocated bottles); ALL-CAPS abbreviated names need normalization; wholesale-oriented pricing.

### 2.3 Wikidata / DBpedia — distillery reference layer
Distilleries with country, region, owner, founding date, coordinates, photos. **CC0 (no attribution needed)** via SPARQL. Good for notable distilleries worldwide; weak on craft/new ones and bottle-level data. Use for distillery pages (map, history), not the catalog.

### 2.4 Open flavor datasets — recommendation bootstrapping
- **Classic 86-distillery Scotch dataset**: 86 single malts scored 0–4 on 12 flavor dimensions — small but perfect for bootstrapping flavor-similarity before we have user data.
- WhiskeyProject/whiskey-api (~370 whiskeys, ~70 flavor tags), 2.2k scraped Whisky Advocate reviews (⚠️ copyright risk if surfaced verbatim — use for internal priors only, if at all).

### 2.5 What we can NOT build on
- **Whiskybase** — no official API; undocumented private API serves their own app; scraping is legally risky and would poison the well for a future partnership. The right move long-term is a **licensing conversation**, not a scraper.
- **Vivino/Distiller data** — closed.
- **Systembolaget & LCBO** — cautionary tales: both retailers *revoked* previously open product APIs (Systembolaget explicitly to prevent commercial alcohol promotion). Never build a core feature on a single third-party feed.

---

## 3. Barcode resolution

Order of resolution at scan time:

1. **Own DB** (seeded from COLA Cloud barcode extractions + Iowa identifiers + user confirmations).
2. **UPCitemdb** — 715M+ claimed UPCs; free 100 req/day, Dev $99/mo (20k/day). Best volume-per-dollar.
3. **Open Food Facts** — free, no key, but spirits coverage is thin and **ODbL share-alike licensing** means we must NOT merge OFF data into our proprietary DB (use as transient lookup only; consider contributing user scans back as goodwill).
4. **Miss → photo + OCR flow** that grows our own DB (every miss is a data-acquisition event).

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

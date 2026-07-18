# Whaikey — Competitor & Market Analysis

Companion to [PLAN.md](../PLAN.md) and [FEATURES.md](./FEATURES.md). Based on live web research (app stores, company sites, press, review sites) conducted July 2026. Claims that couldn't be confirmed from a primary source are marked *(unverified)*.

**TL;DR:** The whiskey app market is fragmented — every competitor owns one slice (database, flavor data, valuation, commerce, inventory UX) and nobody combines strong scanning + deep database + honest valuation + personalization + AI. The wine market proves the playbook (Vivino's scan-first flywheel, InVintory's collector paywall, CellarTracker's subscription pivot). Whaikey's opening is to be the first whiskey app that is *reliable, fast, and AI-native across the whole stack*.

---

## 1. Market map

```
                    DISCOVERY / COMMUNITY                COLLECTION / VALUATION
                 ◀───────────────────────────────────────────────────────────▶
   WINE      Vivino (65M+ users)  Delectable      CellarTracker   InVintory   Cellared
   WHISKEY   Distiller  Whiskybase  Whiskey Social  BAXUS  Whiskey Shelf  Whiskystats/RW101
                        │                                   │
                        └── nobody owns both sides ─────────┘
   COMMERCE  Vivino marketplace · Flaviar (club) · BAXUS (tokenized marketplace)
   AI-NATIVE Dram (2026, tiny) · Daily Pour (buggy) · WhiskeyMate "Fitz" (indie)
```

Collectors in both categories literally run **two apps** (discovery app + cellar app) and export/import between them. That seam is the opportunity.

---

## 2. Whiskey competitors

### 2.1 Distiller — the incumbent "industry default"

| | |
|---|---|
| Platforms | iOS, Android, web · 10+ years old |
| Scale | ~50–60k spirits DB; 4.7★ iOS (~4.9k ratings), 4.5★ Android |
| Model | Freemium; **Pro $4.99/mo / $48/yr** (scanning ad-free, TruePrice values, flavor search, quantities, export); ads on free |

- **Strengths:** deepest expert-review database; best flavor-profile visualization in whiskey ("flavor graph"); TruePrice fair-market values; trusted brand.
- **Weaknesses:** scanning/price data behind paywall or ads; thin social; all-spirits (not whiskey-specialized); slow feature velocity *(unverified)*; users request flavor-slider search it doesn't have.
- **Lesson for Whaikey:** flavor data + expert credibility is Distiller's moat, but they've under-invested in the *personal* layer (your bar, your palate). Their $48/yr price point validates ours.

### 2.2 Whiskybase — the database king with a broken mobile app

| | |
|---|---|
| Platforms | Web-first; iOS/Android apps poorly rated (2.5★ Google Play) |
| Scale | ~230k+ bottles, 1.2M+ ratings, since 2007; EU collector standard |
| Model | Free core; Plus (paid); Supporter €100/yr; marketplace fees *(unverified)* |

- **Strengths:** unmatched bottle-level granularity (single-cask depth), 0–100 community ratings with outlier trimming, live pricing from 50+ countries, marketplace.
- **Weaknesses:** the most-cited complaint is the gap between the excellent web DB and crashy, stagnant mobile apps (login loss, missing features, dated UX).
- **Lesson:** the serious-collector data bar is high, but **mobile execution is an open flank** — the biggest database in whiskey has a 2.5★ app.

### 2.3 BAXUS (ex-BoozApp) — valuation + tokenized marketplace

| | |
|---|---|
| Platforms | iOS 4.6★, Android ~4.2★, web marketplace |
| Scale | 75k+ US bottles with MSRP vs. market vs. crowd "Fair Price"; $5M seed (Multicoin, Solana Ventures) |
| Model | Free app; marketplace transaction + vault fees; Solana NFT-tokenized authenticated bottles |

- **Strengths:** best free at-the-shelf price checker; only player combining tracking + authenticated marketplace + custody; fastest-moving in the niche (v5.0 in 2026).
- **Weaknesses:** crowd-data quality; US-only pricing; crypto framing may alienate mainstream collectors *(unverified)*.
- **Lesson:** price checking is a proven hook. But they're commerce-first — tasting notes, palate, and pairing are afterthoughts. We don't need blockchain to win trust; we need honest estimates with ranges.

### 2.4 Dram — the first pure "AI whiskey app" (Feb 2026)

- iOS only, brand new, too few ratings to display. AI scanner, AI tutor with Duolingo-style lessons/XP, 12-dimension palate radar, cocktail suggestions. **$3.99/mo / $29.99/yr**, free tier capped at 5 scans/month.
- **Lesson:** validates the AI-native concept and our pricing band, but it's education-first, has no community/database depth, and no Android. The window to be *the* AI whiskey app is still open — but it's closing.

### 2.5 The Daily Pour (ex-Bottle Raiders) — AI review aggregator, media-backed

- "Rotten Tomatoes for spirits": AI scan → aggregated expert reviews → normalized "Raided Score" across 10k+ spirits. Free + $4.99/mo premium; Dan Abrams/Mediaite-backed. iOS 3.4★ — **top complaint: the scanner crashes on launch.**
- **Lesson:** money + media distribution doesn't save you if the core loop is unreliable. Scan reliability is table stakes; a broken scanner is worse than no scanner.

### 2.6 Indie collection-tracker cohort

| App | Notable | Model | Signal |
|---|---|---|---|
| **Whiskey Shelf** | Infinity-bottle tracking, pour logs, trading network; famously responsive devs | ~$80/yr premium | 4.5★, 10k+ users — price seen as steep |
| **WhiskeyMate** | 300k+ bottle DB claim, AI assistant "Fitz," PDF export | IAPs $4–$100 | 4.7★ but tiny; iOS-only |
| **OnlyDrams** | Bottle lifecycle statuses (drank/sold/traded/gifted), distillery-verified "Bottle Drops" | Freemium Elite tier | Niche |
| **The Whiskey Companion** | 3M+ auction records, real-time vault valuation, auction alerts | ~€50/yr | Best auction coverage in an app |
| **Whiskey Social** | Free, community-first feed, venue pages | Free | 4.8★ but ~10 ratings |
| **Whizzky** | Early scanner + clubs concept | Free | Multi-year bugs; perceived abandoned |
| **Drammer** | Curated DB, festivals, 14 currencies, since 2010 | Free | Low velocity *(unverified)* |

- **Lesson:** inventory UX ideas worth stealing (lifecycle statuses, infinity bottles, store-pick/barrel-number tracking from BarrelBook), but every indie is starved on database quality and platform coverage. None has AI + database + polish together.

### 2.7 Valuation data layer (not consumer apps)

- **Rare Whisky 101** (UK): indices (Icon 100 etc.), bespoke valuations, feeds the Knight Frank index. **Whiskystats** (AT): ~280k whiskies, millions of auction records, tiered subscription, the de facto EU auction-price authority.
- **Critical market context:** the whisky secondary market has sharply corrected — Knight Frank/RW101 index **−9% in 2024** (still +192% over 10 years); single-malt auction transaction value **−53% YoY** in the four months to Jan 2025, volumes −21%.
- **Lesson:** collection-value features must handle *declining* prices honestly (ranges, trends, "estimate" framing). "Whiskey always appreciates" messaging is now a credibility liability. Long-term, licensing Whiskystats-style data beats building auction scraping ourselves.

---

## 3. Wine adjacents (the proven playbook)

### 3.1 Vivino — scan-first flywheel at scale

- ~65–74M registered users *(sources vary)*, 13–16M wine DB, 500+ merchant marketplace. Revenue: ~15% marketplace commission *(third-party analyses)* + Premium (~$6.99/mo *(unverified)*: wine-list scanner, exact Match-for-You scores, drinking windows, Wine Adventures) + ads + data licensing.
- **Why the loop worked:** the scan answers the highest-anxiety moment in the category (standing at the shelf facing an unfamiliar label) in <5 seconds with no account friction. ~95% of users have scanned. Every scan feeds the DB (network effect) and the user's taste profile (lock-in) → "Match for You" 0–100% personal score on every wine page → marketplace layered *on top of* the habit, never as the entry point.
- **Complaints to avoid:** scan IDs the winery but wrong wine/varietal; ratings inflation toward crowd-pleasers; commerce/support failures (bot-only support, ~2.0★ Trustpilot) poisoning the app's reputation; weak serious-cellar tooling.
- **Whiskey translation:** our shelf-anxiety moment is *price + "will I like it"* — the scan must answer both. Taste-match % on every bottle page (FEATURES.md §5.2) is our Match-for-You.

### 3.2 InVintory — the collector premium tier that works

- iOS-only (Android "in progress" for years). Free (unlimited tracking) → **Premium $14.95/mo / $119/yr** (3D "VinLocate" cellar maps, market valuations, analytics, "Vincent" AI somm grounded in *your* collection) → Elite custom pricing (3D modeling, sensors, concierge, provenance).
- Collectors' verdict: better than Vivino at location, inventory-grounded AI recs, analytics, drink windows — and they import your Vivino data to switch you.
- **Complaints:** heavy paywall on differentiators; missing Android; DB accuracy issues.
- **Lesson:** collectors pay real money ($119/yr!) for *management + valuation + inventory-grounded AI*. Import-from-competitor is a deliberate switching weapon (our CSV/spreadsheet import, FEATURES.md §1.4). Don't repeat the single-platform mistake.

### 3.3 CellarTracker — the monetization natural experiment

- 20+ years, 13M+ ratings, tracking $21B of wine. **Abandoned pay-what-you-want** for a clear tiered subscription (free → ~$40/yr → up to ~$500/yr scaled by cellar size): pay rate **doubled**, subscribers **tripled**, renewals >90%.
- Shipped real AI 2024–26: note summarization, "Will I like this?" prediction, AI pairing, CellarChat.
- Founder line worth keeping: *"We are a pure consumer subscription business, but we also feel very strongly that CellarTracker should be the best free product available."*
- **Complaints:** two decades of dated/cluttered UI; mobile lags desktop.
- **Lesson:** clear gated value beats voluntary support, decisively. Cellar-size-scaled pricing is an interesting alternative to flat Pro (a 500-bottle collector gets more value than a 10-bottle beginner). And even a beloved incumbent is vulnerable on UI.

### 3.4 Others, briefly

- **Delectable/Vinous** — "Instagram of wine," sommelier-heavy community, premium = pro-critic reviews layered on ($5.99/mo). Stagnant since acquisition. Lesson: expert content is a premium hook; a social app that stops shipping dies slowly.
- **Cellared (cellared.ai)** — new entrant winning attention with one technical wedge: a 10-factor "Ageability Index" for personalized drink windows. Lesson: a single credible, methodology-based feature can differentiate against giants.
- **AI-somm commoditization:** VinoVoss, Wine Engine, plus B2B somms (sommify.ai etc.). Everyone shipped an "AI sommelier" in 2024–26. Generic chat is already table stakes; **grounding in the user's own collection and palate is the differentiator** — exactly our architecture (PLAN.md §4.4).

---

## 4. Comparison matrix

Legend: ● strong · ◐ partial/paywalled · ○ weak/absent. (Wine apps included as pattern references.)

| Capability | **Whaikey (target)** | Distiller | Whiskybase | BAXUS | Dram | Whiskey Shelf | Vivino | InVintory | CellarTracker |
|---|---|---|---|---|---|---|---|---|---|
| Label/barcode scan | ● | ◐ paywalled | ◐ buggy | ● | ● | ◐ | ● | ◐ | ◐ |
| Database depth | ◐→● | ● | ●● | ◐ US | ○ | ○ | ● | ◐ | ● |
| Inventory / My Bar | ● | ◐ | ◐ | ● | ◐ | ● | ◐ | ●● | ● |
| $ / valuation tracking | ● honest ranges | ◐ Pro | ● | ●● | ○ | ◐ | ○ | ● | ● auction-fed |
| Tasting notes & flavor wheel | ●● wheel-native | ● graph | ● | ○ | ◐ radar | ◐ | ◐ | ◐ | ● text-heavy |
| Personal palate model | ●● | ○ | ○ | ○ | ◐ | ○ | ● Match-for-You | ◐ | ◐ "Will I like this?" |
| Recommendations (explained) | ●● | ◐ | ○ | ○ | ◐ | ○ | ● | ● from cellar | ◐ |
| Pairings | ● + reverse | ○ | ○ | ○ | ◐ cocktails | ○ | ◐ | ● | ◐ AI |
| AI chat w/ your data | ●● tool-calling | ○ | ○ | ○ | ◐ tutor | ◐ Fitz | ◐ | ● Vincent | ● CellarChat |
| Voice → structured notes | ●● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Community ratings | ◐ later | ● | ●● | ◐ | ○ | ○ | ●● | ○ | ●● |
| Mobile quality/reliability | ● non-negotiable | ● | ○ | ● | ? | ◐ | ● | ● iOS | ◐ |
| Cross-platform | ● iOS+Android+web | ● | ◐ | ● | ○ iOS | ● | ● | ○ iOS | ● |

**No column besides ours has ● across scan + database + inventory + palate + AI + reliability.** That's the product.

---

## 5. Gaps Whaikey exploits

1. **The two-app problem** — discovery apps don't manage collections; collection apps don't do discovery/personalization. One app, one data model (own/tried/wishlist), both jobs.
2. **Voice-to-structured tasting notes** — literally nobody has it (wine or whiskey). Our clearest signature feature; perfectly suited to the actual moment of use (glass in hand).
3. **Palate-grounded, explained recommendations** — Vivino proved Match-for-You drives engagement; no whiskey app has an equivalent. Whiskey's stable bottlings (vs. wine vintages) actually make this *easier* to build.
4. **Mobile reliability as a feature** — the whiskey category leader-by-database has a 2.5★ app; the best-funded AI entrant has a crashing scanner. Boring excellence wins reviews here.
5. **Honest valuation in a down market** — post-crash, "estimate with range + trend" framing beats hype; almost everyone else built valuation UX in the bull market.
6. **AI that acts, not just chats** — every 2024–26 "AI somm" is read-only chat. Tool-calling that executes (add to wishlist, log the pour, build the flight from *your* shelf) is a generation ahead.

## 6. Threats & honest risks

- **Distiller adds a palate model** — they have the flavor data and brand to do it. Mitigation: speed, whiskey-collector depth (they're all-spirits), and the voice/acting-AI features they'd have to rebuild around.
- **BAXUS goes mainstream** on tracking UX with its funding. Mitigation: they're structurally commerce/custody-first; tasting/palate is off-strategy for them.
- **Vivino enters whiskey.** Low signal today *(no evidence found)*, but their playbook + user base would be formidable. Mitigation: whiskey-specific depth (mash bills, barrel picks, proof variants, infinity bottles) that a wine data model handles badly.
- **AI-somm fatigue** — by 2027 "AI sommelier" will be a checkbox. Mitigation: our AI value is in the *data loop* (extraction → palate → grounded action), not the chat veneer.
- **Database cold start** — Whiskybase took 18 years. Mitigation: top-5k bottles cover the vast majority of scans (power-law); aliases + AI enrichment + user submissions for the tail; consider licensing/partnering for auction price data (Whiskystats) rather than building.

## 7. Decisions this analysis feeds back into the plan

| Decision | Basis |
|---|---|
| Keep scanning **free** (generous cap), unlike Distiller | Scan = activation flywheel (Vivino ~95% scan rate); paywalled scanning is Distiller's most-resented gate |
| Price Pro at **$5.99/mo / $49/yr** | Between Dram ($30/yr) and Distiller ($48/yr); far under InVintory ($119/yr); collectors demonstrably pay more when value is clear |
| Consider **collection-size-scaled tier** later | CellarTracker's pivot: pay rate ×2, subscribers ×3 with size-scaled clear gating |
| **CSV + competitor import** at launch | InVintory uses Vivino import as a switching weapon; our targets: Distiller export, Whiskybase export, spreadsheets |
| Valuation = **range + trend + "estimate" framing** | 2024–25 market correction; overconfident numbers destroy trust |
| Mobile reliability & offline as explicit NFRs | The two highest-profile competitor failures (Whiskybase mobile, Daily Pour scanner) are reliability failures |
| Ship **shareable palate wheel** before any social graph | Vivino/Delectable show community is a years-long moat build; shareable cards are the cheap growth loop first |
| Steal: bottle **lifecycle statuses** (OnlyDrams), **infinity bottle** + store-pick/barrel-number tracking (Whiskey Shelf/BarrelBook) | High-value collector features with low build cost — added to FEATURES.md backlog |

---

*Sources: app store listings and reviews (Apple/Google), company sites and pricing pages, Trustpilot, press (BevNet, Forbes, Axios, Decanter, Robb Report, The Block, BusinessWire), productmint/fourweekmba business-model analyses, cellared.ai and whiskeysocial.app roundups (competitor-authored — weighted accordingly). Full URL list preserved in research notes; key claims marked (unverified) where only secondary sources existed.*

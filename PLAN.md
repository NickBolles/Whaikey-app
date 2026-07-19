# Whaikey — Whiskey Tracking App Plan

An AI-native whiskey tracking app, inspired by wine apps like **Vivino** (social scanning + ratings) and **InVintory** (beautiful personal cellar management), but built for whiskey from day one with AI at the core — not bolted on.

> Deep dives: [docs/FEATURES.md](./docs/FEATURES.md) (detailed feature map) · [docs/COMPETITORS.md](./docs/COMPETITORS.md) (competitor & market analysis) · [docs/DATA_SOURCES.md](./docs/DATA_SOURCES.md) (data sourcing strategy)

---

## 1. Vision & Principles

**Vision:** The fastest way to remember, understand, and grow your whiskey journey. Scan a bottle, get instant knowledge, log a pour in seconds, and have an AI companion that knows your palate better than you do.

**Guiding principles:**

1. **AI-native** — AI isn't a feature tab; it powers search, tasting-note capture, recommendations, and a conversational assistant throughout the app.
2. **Fast above all** — Logging a pour or scanning a bottle must take under 10 seconds. Optimistic UI, offline-capable, instant search.
3. **User-friendly** — A collector's app that a beginner can use. Progressive disclosure: simple by default, deep when you want it.
4. **Your palate, not the crowd's** — Community ratings are context; personal taste modeling is the product.

---

## 2. Feature Brainstorm

### 2.1 Bottle Identification & Library

- **Label scan (camera)** — Vivino-style: photograph a label, vision model identifies distillery, expression, age statement, proof. Confirm-or-correct flow.
- **Barcode/UPC scan** — rapid batch mode: scan bottle after bottle and shelve a whole collection in minutes; own-DB-first resolution with crowdsourced UPC→bottle confirmations (FEATURES.md §2.3, DATA_SOURCES.md §3).
- **Text/voice search** with fuzzy matching ("that 12yr Redbreast", "lagavulin 16").
- **"Add to library or not" decision point** — after identifying a bottle, choose:
  - **Own it** → goes into *My Bar* (with purchase price, date, store, open/sealed status, fill level).
  - **Tried it** → log a tasting without owning (bar pour, friend's bottle, sample).
  - **Wishlist** → want to buy later (with target price alerting as a future feature).
  - **Just looking** → view info, save nothing.
- **Bottle detail page** — distillery, region, mash bill, cask type, ABV, age, MSRP vs. street price, community rating, your rating, flavor profile, similar bottles.

### 2.2 My Bar (Inventory)

- Track **owned bottles**: sealed vs. open, fill level (visual bottle gauge), location (shelf/cabinet/office), number of backups.
- **$ tracking**:
  - Purchase price per bottle, tax/fees, store.
  - **Collection value**: total spent, estimated current market value, value change over time.
  - **Cost per pour** — auto-computed from price ÷ pours logged.
  - Spending dashboard: monthly spend, average bottle price, most expensive open bottle.
- **Kill list** — bottles nearly empty; "finish these first" nudges.
- Sort/filter by region, style, price, rating, open status, "haven't touched in 6 months."

### 2.3 Tasting Notes & Ratings

- **Quick pour log** (the core loop): pick bottle → rate → optional note. Three levels of depth:
  1. **One-tap rating** (1–5 stars or 100-pt scale, user preference).
  2. **Guided structured note** — nose / palate / finish, with tappable flavor chips.
  3. **Freeform + voice note** — talk about the dram; AI transcribes and *auto-extracts structured flavors, rating sentiment, and context* into the structured format.
- **Tasting context**: neat / rocks / water / cocktail, glassware, setting, who with.
- **Side-by-side comparison mode** for flights (2–4 bottles, split-screen notes).
- **Blind tasting mode** — hide the label, reveal after rating (great for calibrating your palate).
- Ratings history per bottle — see how your score evolves across pours.

### 2.4 Flavor Wheel

- **Interactive whiskey flavor wheel** (2-tier: 8 core categories → ~60 specific descriptors):
  - Core: Fruity, Floral, Grain/Cereal, Sweet, Woody, Spicy, Peaty/Smoky, Sulfury/Feinty.
  - Tap a wedge to drill into specifics (Fruity → orchard fruit → green apple).
- **Per-bottle wheel**: radar/wheel visualization of a bottle's profile from your notes + community aggregate.
- **Your palate wheel**: aggregated across everything you've rated highly — a visual fingerprint of your taste. This is the input to the recommendation engine and a shareable graphic.
- Wheel doubles as an **input device** during guided tasting (tap wedges instead of typing).

### 2.5 Food & Drink Pairing

- **Pairing suggestions per bottle** — AI-generated, grounded in the bottle's flavor profile (e.g., sherried Speyside → dark chocolate, blue cheese, dried fruit; Islay peat → oysters, smoked brisket).
- **Reverse pairing** — "I'm having steak tonight, what should I pour from my bar?" (searches *your* inventory first).
- **Cigar pairing** (popular with whiskey audience) and **cocktail suggestions** for bottles that suit mixing.
- Log pairings you tried with a worked/didn't-work rating — feeds back into personalization.

### 2.6 Recommendations

- **New bottle recommendations** — "you'll probably love X" based on:
  - Your palate wheel + rating history (collaborative + content-based hybrid).
  - Price band awareness ("similar profile to Blanton's at half the price").
  - Availability/realism (don't recommend unicorns by default; "grail mode" toggle).
- **Explainable**: every recommendation says *why* ("You rated 4 sherry-cask Speysides ≥4.5 stars; this is a sherried Highland at your usual $60–80 range").
- **"What to pour tonight"** — from your own bar, based on mood/occasion/weather/what you've been drinking lately.
- **Gift mode** — recommend for a friend given a few of their favorites.

### 2.7 AI Chat Assistant ("the Whiskey Concierge")

A persistent chat box (floating button + dedicated tab) with full context of your library, notes, and palate. Example queries:

- "What's the difference between bourbon and rye?"
- "Which of my open bottles is closest to being empty?"
- "What should I bring to a dinner party for someone who likes Macallan 12?"
- "Summarize my tasting notes on Ardbeg 10 over the last year."
- "Is $95 a good price for Eagle Rare 10 right now?"
- "Build me a 5-bottle starter flight to learn Scotch regions."

Implementation: LLM with **tool calling** into the app's own APIs (query inventory, query notes, search bottle DB, get market prices, add to wishlist) — so the assistant can *act*, not just answer ("add it to my wishlist" actually does it, with confirmation).

### 2.8 Social & Community (later phases)

- Follow friends, share tasting notes and shelf photos, comment.
- Community ratings & note aggregation per bottle (the Vivino moat).
- Clubs/groups for whiskey societies; shared virtual flights.
- Local availability & price reports crowdsourced from users.
- **Blind taste test / flight setup** — host picks bottles from their bar (or a shared pool) and creates a "flight" for an in-person tasting; app assigns each bottle a blind letter/number so labels are hidden from participants. Each guest logs ratings + flavor-wheel notes per blind slot from their own phone; host (or a scheduled reveal trigger) unmasks the bottle identities at the end so the group can compare notes, see who guessed closest, and see aggregate scores per bottle. Useful for tasting clubs, gifting reveals, and "guess the mystery pour" nights. Depends on the existing pour-logging + flavor-wheel + multi-user session primitives; no new pricing/valuation claims involved (ratings only, not $ estimates) so it stays within the responsible-drinking and no-false-precision guardrails.

### 2.9 Extras / Delighters (backlog)

- **Stats & Wrapped** — yearly "Whiskey Wrapped" recap (top bottle, flavor journey, spend… optionally hidden 😅).
- Distillery map + visited-distillery passport.
- Sample/bottle-share management (track 2oz samples, who you owe).
- Insurance export (CSV/PDF of collection with values).
- Home-screen widgets: "tonight's pour," collection value.
- Badges/achievements ("All 5 Scotch regions," "100 pours logged").

---

## 3. Prioritization (MoSCoW for v1)

| Must have | Should have | Could have | Won't have (v1) |
|---|---|---|---|
| Bottle search + detail pages | Label photo scan | Blind tasting mode | Social graph/feed |
| Barcode/UPC scan (rapid collection import) | Voice note → structured note | Cigar pairing | Marketplace/price alerts |
| My Bar with $ tracking | Palate wheel visualization | Gift mode | Distillery passport |
| Quick pour log + ratings | Reverse pairing from my bar | Widgets | Community price reports |
| Structured notes + flavor chips | Collection value estimates | Wrapped recap | |
| Interactive flavor wheel | Explainable recommendations | | |
| AI chat with tool calling | | | |
| Wishlist / tried / own flows | | | |

---

## 4. Architecture & Tech Stack

### 4.1 Recommended stack

- **App:** React Native + Expo (iOS + Android + web from one codebase; fast iteration, OTA updates). Tamagui or NativeWind for UI.
- **Backend:** Supabase (Postgres + Auth + Storage + Realtime + Edge Functions) — fast to ship, Postgres gives us `pgvector` for embeddings and full-text search for instant bottle lookup.
- **AI layer:** Anthropic Claude via a thin server-side gateway (Edge Function):
  - `claude-sonnet-5` for chat, note extraction, pairing/rec explanations.
  - `claude-haiku-4-5` for cheap/fast tasks (autocomplete, flavor-chip extraction).
  - Vision (image input) for label scanning.
- **Search:** Postgres FTS + trigram for instant-as-you-type; `pgvector` embeddings for "bottles like this" similarity.
- **Analytics/monitoring:** Sentry + PostHog.

### 4.2 High-level architecture

```
┌────────────────┐     ┌──────────────────────────────┐
│  Expo App      │────▶│  Supabase                    │
│  (iOS/Android/ │     │  • Postgres (+pgvector, FTS) │
│   Web)         │     │  • Auth / RLS                │
│                │     │  • Storage (label photos)    │
│  Local cache   │     │  • Edge Functions ──────────┐│
│  (offline log) │     └──────────────────────────────┘│
└────────────────┘                    │                │
                                      ▼                ▼
                        ┌──────────────────┐  ┌──────────────┐
                        │ AI Gateway (EF)  │  │ Bottle DB     │
                        │ • Chat + tools   │  │ seed/import   │
                        │ • Label vision   │  │ pipeline      │
                        │ • Note extraction│  └──────────────┘
                        │ • Recs/pairings  │
                        └──────────────────┘
                                 │
                                 ▼
                          Claude API
```

Key decisions:
- **All AI calls server-side** (Edge Functions) — no API keys in the client, per-user rate limiting, response caching (pairings/recs for a bottle are cacheable).
- **AI chat uses tool calling** against internal APIs: `search_bottles`, `get_my_bar`, `get_tasting_notes`, `add_to_wishlist`, `get_pairings`, `recommend_bottles`. Destructive/creative actions require in-chat confirmation.
- **Offline-first pour logging**: queue writes locally, sync on reconnect (a bar basement has no signal).
- **Bottle database**: seed from open datasets + AI-assisted enrichment (flavor profiles, descriptions), dedupe pipeline, user-submitted bottles go through a review queue. Sourcing detailed in §4.5.

### 4.3 Core data model (simplified)

```
users(id, handle, palate_profile jsonb, prefs jsonb)

bottles(id, distillery_id, name, category,      -- bourbon/scotch/rye/irish/japanese/...
        region, age_years, abv, cask_types[],
        msrp, avg_street_price, flavor_profile jsonb,   -- wheel scores 0-10 per category
        embedding vector, image_url, status)            -- status: verified/user_submitted

distilleries(id, name, country, region, founded, lat, lng)

user_bottles(id, user_id, bottle_id,
             relationship,                 -- own / tried / wishlist
             status,                       -- sealed / open / finished
             fill_level, purchase_price, purchase_date, store,
             est_market_value, location_label, notes)

pours(id, user_id, bottle_id, user_bottle_id?,
      rating, serving_style,               -- neat/rocks/water/cocktail
      context jsonb,                       -- setting, companions, glassware
      created_at)

tasting_notes(id, pour_id, nose text, palate text, finish text,
              freeform text, voice_transcript text,
              flavor_tags jsonb,           -- {wedge: intensity} from wheel/AI extraction
              extracted_by)                -- user / ai

pairings(id, bottle_id, pairing_type,      -- food/cigar/cocktail
         suggestion, rationale, source,    -- ai/community
         user_feedback_score)

chat_sessions(id, user_id) / chat_messages(id, session_id, role, content, tool_calls jsonb)

price_history(bottle_id, date, price, source)   -- powers $ trends & "good price?" answers
```

Row-level security throughout: users only see their own bars/notes; bottles/distilleries are public-read.

### 4.5 Data sourcing (summary — full strategy in [docs/DATA_SOURCES.md](./docs/DATA_SOURCES.md))

There is no single whiskey API; the catalog is assembled in layers, mostly free at launch:

| Layer | Launch sources (free) | Paid upgrades (when funded) |
|---|---|---|
| **Bottle catalog** | TTB COLA registry (US label approvals + images; public record), Iowa Liquor Products dataset (clean SKU catalog), Wikidata distilleries (CC0), 86-distillery Scotch flavor dataset | COLA Cloud API (repackaged COLA + 575k extracted barcodes), Whiskybase *licensing conversation* (never scraping) |
| **Barcodes** | Own DB first; UPCitemdb free tier; Open Food Facts fallback (ODbL — never merged into our DB) | UPCitemdb Dev $99/mo |
| **Prices/valuation** | Iowa monthly price data, control-state price books (VA/NC/OH/PA), Whisky Hunter free auction-trend API, affiliate feeds (Whisky Exchange, Master of Malt, Total Wine — live prices + revenue) | Wine-Searcher API (covers spirits), Whiskystats auction data |
| **Label scanning** | Barcode-first → OCR text match (labels are text-heavy) | TinEye WineEngine or Vuforia visual matching, seeded with COLA label images (Vivino's stack) |

Principles: every third-party lookup converts into a first-party record (user confirmations, corrections, prices paid — the moat we control); every external feed has a degraded-but-working fallback (Systembolaget/LCBO both revoked open APIs); legal checklist (COLA image posture, ODbL isolation, feed ToS) clears before launch.

### 4.6 The palate model (what makes it AI-native)

1. Every tasting note (typed, tapped, or spoken) → Haiku extracts normalized flavor tags mapped to the wheel taxonomy.
2. Ratings × flavor tags accumulate into `users.palate_profile` (weighted flavor-preference vector, updated incrementally).
3. Recommendations = vector similarity (bottle embeddings vs. palate vector) → filtered by price band/availability → **re-ranked and explained by Claude** with the user's actual history in context.
4. The same profile grounds chat answers, pairing suggestions, and "what to pour tonight."

---

## 5. Roadmap

### Phase 0 — Foundation (week 1–2)
- Expo app scaffold, Supabase project, auth (Apple/Google/email), CI.
- Schema + RLS, bottle DB seeded with ~2–5k popular bottles (Iowa Products + TTB COLA + Wikidata pipeline, §4.5).
- Design system: dark, warm, whiskey-toned; bottle card + detail components.

### Phase 1 — Core loop MVP (week 3–6)
- Bottle search (instant FTS) + detail page.
- Barcode/UPC scan with rapid batch mode (collection import in minutes).
- Own / tried / wishlist flows; My Bar with purchase price + totals.
- Quick pour log with 3-depth notes; flavor-chip input; ratings.
- Interactive flavor wheel (input + per-bottle visualization).
- **Milestone: you can replace your spreadsheet/notes app.**

### Phase 2 — AI-native layer (week 7–10)
- AI gateway Edge Function; chat assistant with tool calling.
- Voice/freeform note → structured extraction.
- Label photo scan → identify flow.
- Pairing suggestions (cached per bottle) + reverse pairing from My Bar.
- **Milestone: the concierge works and feels magical.**

### Phase 3 — Personalization & polish (week 11–14)
- Palate profile + palate wheel; explainable new-bottle recommendations; "what to pour tonight."
- Cost-per-pour, collection value dashboard, price history basics.
- Offline pour logging, performance pass (cold start < 2s, search < 100ms).
- **Milestone: App Store / Play Store beta (TestFlight first).**

### Phase 4 — Growth (post-launch)
- Community ratings/notes aggregation, friends & sharing, Wrapped recap.
- Price alerts on wishlist, blind tasting mode, widgets.
- Launch premium tier (see §6 Monetization).

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

### 6.2 Premium — "Whaikey Pro" (~$5.99/mo or $49/yr; ~30% annual discount)

Sell the *palate + portfolio* story — "know your taste, know your bar's worth":

- **Unlimited AI concierge** chat + voice-note extraction.
- **Palate wheel + explainable recommendations** ("because you loved X…").
- **Collection value tracking** — market value estimates, value-over-time chart, cost-per-pour, spending analytics.
- Unlimited label scans, price history on bottles, wishlist price alerts (when built).
- Blind tasting mode, flight comparison, CSV/PDF export (insurance reports).
- Yearly "Whiskey Wrapped" in full (free users get a teaser).

Pricing logic: whiskey collectors routinely spend $50–100+ per bottle; $6/mo is < 2% of a single mid-shelf purchase. Anchor the annual plan as "less than one pour of Blanton's per month."

### 6.3 Later revenue streams (post-traction, in order of attractiveness)

1. **Affiliate/referral on recommendations** — "buy near you / online" links from bottle pages and rec cards (Vivino's core model). Strict rule: recommendations are *never* pay-to-rank; affiliate revenue is disclosed and downstream of an honest rec, or trust dies.
2. **Retailer/brand analytics (B2B)** — aggregated, anonymized demand and flavor-trend data ("sherry-cask demand up 40% in Texas"). Privacy-first: opt-out, aggregate-only, no individual data sales.
3. **Distillery partnerships** — sponsored (clearly labeled) tasting flights, early releases, virtual tastings inside clubs.
4. **One-time IAPs** — lifetime unlock option (~$149) for subscription-averse collectors; gift subscriptions.

**Explicitly not doing:** selling user data, ads in the tasting flow, pay-to-win community rankings, or paywalling data users entered themselves (your notes/inventory are always exportable — even on free).

### 6.4 Unit economics sanity check

- Main variable cost is AI inference. Mitigations already in §7 risks: Haiku for high-volume extraction, per-bottle caching of pairings/recs, rate limits on free tier.
- Rough target: keep AI cost per premium user < $1/mo (achievable with caching + Haiku routing) → healthy margin at $5.99.
- Conversion assumption to validate in beta: 3–5% free→paid (typical for prosumer hobby apps; collectors likely convert higher).

### 6.5 Rollout

- **Beta:** everything free, instrument usage to find the real willingness-to-pay lines.
- **Launch:** grandfather beta users with 3 months of Pro; introduce paywall with the limits above.
- Revisit free-tier AI message cap based on actual cost data — generosity is a growth lever, not a loss center, if caching works.

---

## 7. Risks & open questions

| Risk | Mitigation |
|---|---|
| Bottle database quality/coverage | Layered sourcing per §4.5 (TTB COLA + Iowa + Wikidata seed); AI-assisted enrichment; user submissions with review queue; fuzzy matching so near-misses still resolve |
| Data source revocation (Systembolaget/LCBO precedent) | Single-source risk rule: every feed has a fallback; convert lookups into first-party records (DATA_SOURCES.md §6) |
| AI cost per user | Haiku for high-volume tasks, cache pairings/recs per bottle, rate-limit free tier, premium tier absorbs heavy chat users |
| Label scan accuracy (bottle variants, private barrels) | Always confirm-or-correct UX; log corrections as training/eval data |
| Market price data (no clean whiskey API) | Start with MSRP + user-entered prices; crowdsource street prices; treat "value" as estimate with ranges |
| Scope creep (this doc proves it) | Ship the Phase 1 core loop before touching Phase 2 |

**Open questions to resolve before Phase 1:**
1. Rating scale default — 5 stars (casual, Vivino-like) vs. 100-pt (enthusiast)? *Proposal: 5 stars with 0.5 steps, optional 100-pt mode in settings.*
2. iOS-first or simultaneous Android? *Proposal: build cross-platform, but polish/beta iOS first.*
3. Name: "Whaikey" — placeholder or keeper?

---

## 8. Immediate next steps

1. Approve/adjust this plan (especially §3 priorities, §6 pricing, and §7 open questions).
2. Scaffold Expo app + Supabase project (Phase 0).
3. Design the 4 core screens: Search, Bottle Detail, My Bar, Pour Log.
4. Build the bottle-DB seed pipeline.

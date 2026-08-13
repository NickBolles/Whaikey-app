# Whaikey — Whiskey Tracking App Plan

An AI-native whiskey tracking app, inspired by wine apps like **Vivino** (social scanning + ratings) and **InVintory** (beautiful personal cellar management), but built for whiskey from day one with AI at the core — not bolted on.

> Deep dives: [docs/FEATURES.md](./docs/FEATURES.md) (detailed feature map) · [docs/SOCIAL.md](./docs/SOCIAL.md) (social layer: friends, comparison, clubs, privacy) · [docs/COMPETITORS.md](./docs/COMPETITORS.md) (competitor & market analysis) · [docs/DATA_SOURCES.md](./docs/DATA_SOURCES.md) (data sourcing strategy)

---

## 1. Vision & Principles

**Vision:** The fastest way to remember, understand, and grow your whiskey journey. Scan a bottle, get instant knowledge, log a pour in seconds, and have an AI companion that knows your palate better than you do.

**Guiding principles:**

1. **AI-native** — AI isn't a feature tab; it powers search, tasting-note capture, recommendations, and a conversational assistant throughout the app.
2. **Fast above all** — Logging a pour or scanning a bottle must take under 10 seconds. Optimistic UI, offline-capable, instant search.
3. **User-friendly** — A collector's app that a beginner can use. Progressive disclosure: simple by default, deep when you want it.
4. **Your palate, not the crowd's** — Community ratings are context; personal taste modeling is the product. Friends' palates are the *most useful* context, which is why the social layer compares palates rather than aggregating them into an average.
5. **Social by comparison, never by consumption** — Whiskey is drunk with people, so the app is better with people in it. But the shared thing is *the bottle* and the compared thing is *your palate* — never how much or how often you drink. Every social mechanic must be winnable by a moderate drinker, or it doesn't ship ([docs/SOCIAL.md](./docs/SOCIAL.md) §3).

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
- **Low-fill context** — can inform a personal recommendation without a standalone finish-first nudge.
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

### 2.8 Social & Community — "Strava for whiskey" (full design: [docs/SOCIAL.md](./docs/SOCIAL.md))

**The organizing idea:** Strava works because everyone runs the same *segment*, which makes comparison meaningful. In whiskey, **the bottle is the segment** — and what varies is the palate, not the performance. So the question our social layer asks is never "who drank the most?" but **"what did you taste that I didn't?"** That substitution is what lets us be socially competitive without becoming a consumption leaderboard.

- **Share what you tried, what you tasted, and how it compared** — a pour you already logged becomes shareable with one visibility flag (no separate composer). Shipped today as bearer-token public links (`/s/[code]`); the social layer adds revocation first (S1), then identity and friend-scoped visibility (S2).
- **Same Dram** *(signature)* — the bottle page shows **you vs. the producer vs. your friends** in the same flavor coordinate space. It reuses the shipped `getFlavorCalibration()` buckets (shared / blind / signature) and adds a social one (**contested**). The payoff line — *"where Sarah writes clove, you write cinnamon"* — is the reason to open the app. The two-person version ships first on the existing share page (S1), with no graph — which is also how we test the sparse-overlap risk for the cost of one page section.
- **Comparison stream** — a "From your friends" module on Home (not a tab; a sparse early graph would make a dedicated feed tab feel dead — SOCIAL.md §6.3). Chronological, friends-only, and every card carries a "you tasted this too / 3 friends tasted this" comparison hook. Explicitly *not* a generic activity stream; competitors already have those.
- **Follow graph + profiles** — the profile *is* your palate card (palate wheel, signature descriptors, regions covered), not a wall of pours. Asymmetric follow; mutual follows derive "friends" for the more intimate surfaces.
- **Taste twins** — palate-vector similarity gives us the collaborative-filtering signal a content-based recommender can't generate alone, and makes recommendations explainable ("your two closest palate matches both rated it 4.5+").
- **Clubs** — small groups (societies, bottle-share crews, four friends) with a shared shelf, club feed, and club palate wheel. Small-group belonging is the strongest retention mechanic Strava has.
- **Blind taste test / flight setup** — host picks bottles from their bar (or a shared pool) and creates a "flight" for an in-person tasting; app assigns each bottle a blind letter/number so labels are hidden from participants. Each guest logs ratings + flavor-wheel notes per blind slot from their own phone; host (or a scheduled reveal trigger) unmasks the bottle identities at the end so the group can compare notes, see who guessed closest, and see aggregate scores per bottle. Now also produces a group-level Same Dram view (the whole table vs. the producer's notes) and a shareable results card. Ratings only, no $ estimates, so it stays inside the responsible-drinking and no-false-precision guardrails — and it pushes engagement toward shared, occasion-based drinking rather than solo daily logging.
- **Bottle shares & samples** — track the 2 oz you sent a friend, and see the note they wrote from it. Rewards generosity, not consumption.
- Community ratings & note aggregation per bottle (the Vivino moat), including **community flavor consensus vs. the producer's claim** — *"the label says honey; 71% of drinkers say caramel"* — which nobody else can compute without our shared taxonomy plus attributed producer notes.
- Local availability & price reports crowdsourced from users.

**Non-negotiable constraints** (detail in SOCIAL.md §3 and §8, grounded in the published critique of Untappd's gamification): no streaks, no volume/frequency/ABV badges, no consumption leaderboards, no "your friends are drinking now" presence, no pour-nudging notifications. Everything is **private by default**; money data (purchase price, collection value, spend) never crosses a social boundary at all.

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
| Bottle search + detail pages | Label photo scan | Blind tasting mode | Social graph & feed |
| Barcode/UPC scan (rapid collection import) | Voice note → structured note | Cigar pairing | Clubs / group tastings |
| My Bar with $ tracking | Palate wheel visualization | Gift mode | Marketplace/price alerts |
| Quick pour log + ratings | Reverse pairing from my bar | Widgets | Distillery passport |
| Structured notes + flavor chips | Shareable pour/palate cards (link-based) | Wrapped recap | Community price reports |
| Interactive flavor wheel | Collection value estimates | | |
| AI chat with tool calling | Explainable recommendations | | |
| Wishlist / tried / own flows | Your notes vs. producer notes (calibration) | | |

**On social specifically:** the *graph* is deliberately post-v1 (Phase S2+, [docs/SOCIAL.md](./docs/SOCIAL.md) §13), but **link-based sharing ships early** — it's the growth loop, it needs no graph, and it's already live for pours. The private journal has to be worth using alone before a network can carry it.

---

## 4. Architecture & Tech Stack

### 4.1 Recommended stack

- **App:** ~~React Native + Expo~~ → **Next.js App Router on the web, wrapped by Capacitor for iOS/Android.** This section predates any code; once the web app existed, React Native meant rewriting ~7k lines of UI plus the whole test and visual-regression harness while buying nothing on the server. The full comparison, tripwires for revisiting the decision, and the native architecture are in [docs/NATIVE_APP.md](./docs/NATIVE_APP.md).
- **Backend:** Postgres (Supabase is the intended hosted option; PGlite provides local/test parity) + Better Auth + storage/realtime integrations as needed. Postgres gives us `pgvector` for embeddings and full-text search for instant bottle lookup.
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

-- Social layer (Phase S1+; full sketch in docs/SOCIAL.md §9)
user_profiles(user_id, handle, display_name, avatar_url, bio, is_public)
follows(follower_id, followee_id, state)        -- asymmetric; mutual = "friends"
blocks(blocker_id, blocked_id)
pours.visibility                                -- private (default) / friends / followers / public
reactions(subject_type, subject_id, user_id, kind) / comments(...)
clubs(...) / club_members(...) / club_shelf(...)
blind_flights(...) / blind_flight_slots(...) / blind_flight_entries(...)
user_palate_similarity(user_a, user_b, score)   -- cached "taste twin" matching
```

Row-level security throughout: users only see their own bars/notes; bottles/distilleries are public-read.

**Social read-path rule:** every social surface reads through an explicit projection function that selects columns individually (the shipped `getPublicPourShare()` pattern), never a whole `pours` or `user_bottles` row. Purchase price, collection value and spend are structurally absent from those projections — that's how money data is kept from ever crossing a social boundary.

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

### Phase 4 — Growth & the social layer (post-launch)

Each phase ships a loop a user can feel, and the riskiest assumption (sparse note overlap) is tested by the cheapest phase. User stories, page map and milestones in [docs/SOCIAL.md](./docs/SOCIAL.md) §5–§6 and §13; S1 has an agent-ready build spec (§16) and zero open decisions.

- **S1 — Share control & the first comparison:** share-link revocation + a "shared links" page; the share page shows a signed-in viewer how their notes on the same bottle compare, plus a wishlist hook. No graph, no profiles.
- **S2 — Friends & Same Dram:** profiles + handles, palate card, follow graph, per-pour visibility (default *only me*), blocks, the "From your friends" Home module, **Same Dram** (you vs. producer vs. friends), cheers, notification policy, one-tap "make everything private."
- **S3 — Conversation & groups:** comments + reports, clubs, blind flights end-to-end (no club dependency — flights can lead), taste twins feeding recommendations, bottle shares/samples.
- **S4 — Community scale:** community flavor consensus, crowdsourced availability, moderation tooling, public discovery.
- In parallel: Wrapped recap, price alerts on wishlist, widgets.
- Launch premium tier (see §6 Monetization).

**Structural invariant on every social release:** nothing becomes visible to a second user until the visibility model and block checks are enforced on the read path that serves it (SOCIAL.md §13). Consumption guardrails are enforced as mechanic bans in review (SOCIAL.md §3.1) and verified by cohort-adjusted metrics (SOCIAL.md §12).

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
- **Deeper social analysis** (not social *access* — see 6.2.1): full palate-match breakdowns across your graph, club analytics ("what is this club missing?").
- **Palate wheel + explainable recommendations** ("because you loved X…").
- **Collection value tracking** — market value estimates, value-over-time chart, cost-per-pour, spending analytics.
- Unlimited label scans, price history on bottles, wishlist price alerts (when built).
- Blind tasting mode, flight comparison, CSV/PDF export (insurance reports).
- Yearly "Whiskey Wrapped" in full (free users get a teaser).

Pricing logic: whiskey collectors routinely spend $50–100+ per bottle; $6/mo is < 2% of a single mid-shelf purchase. Anchor the annual plan as "less than one pour of Blanton's per month."

#### 6.2.1 Social is free — all of it

Same logic that keeps scanning free: the graph **is** the growth engine, and a paywalled graph doesn't grow. Profiles, following, the feed, cheers, comments, share links, Same Dram vs. friends, clubs, and blind flights — **hosting included, at any size** — are free forever. A flight night is the app's single best acquisition moment (every guest installs to participate); charging the host would tax the growth loop at its strongest point.

**The line:** if a feature makes the network bigger, it's free; if it makes *your understanding* of the network deeper, it can be Pro. Friends' recommendations are also the most natural buying moment in the app — the §6.3 affiliate rule (never pay-to-rank, always disclosed, always downstream of an honest recommendation) applies there without softening.

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
| **Social drifts into rewarding consumption** (the Untappd failure mode — published research finds its streak/volume/ABV badges unchanged after 5 years of criticism) | Hard mechanic bans enforced in review, not disclaimers (SOCIAL.md §3.1); cohort-adjusted weekly-pour-rate metric as the smoke alarm (SOCIAL.md §12) |
| **Privacy leak through a social surface** — prices, location, or a pour someone thought was private | Private by default, money data structurally absent from social projections, no system-raised visibility changes, revocable links, visibility + block checks land before any read path serves another user (SOCIAL.md §8, §13) |
| **Sparse overlap** — friends haven't tasted the same bottles, so "compare notes" has nothing to compare | Tested in S1 for the cost of one page section (comparison on existing share links, no graph needed); compare at the descriptor level too (palate match needs zero shared bottles); use "3 friends tasted this" as the discovery framing when overlap is absent |
| **Social is table stakes, not a wedge** — Distiller, Whiskybase, DramIt and Whiskey Social all have feeds | Only ship social that is downstream of our moat (taxonomy + calibration + palate model): the comparison card, not the activity stream |

**Open questions to resolve before Phase 1:**
1. Rating scale default — 5 stars (casual, Vivino-like) vs. 100-pt (enthusiast)? *Proposal: 5 stars with 0.5 steps, optional 100-pt mode in settings.*
2. iOS-first or simultaneous Android? *Proposal: build cross-platform, but polish/beta iOS first.* (The Capacitor shell makes both one build — see [docs/NATIVE_APP.md](./docs/NATIVE_APP.md) §4.)
3. Name: "Whaikey" — placeholder or keeper?

**On the social layer:** the open-question list is now a *decision* table — [docs/SOCIAL.md](./docs/SOCIAL.md) §14 records 13 decided calls (asymmetric follow with derived friends; default visibility **Only me** with no system-raised retroactivity; reaction named **"Cheers"**; chronological stream as a Home module; venue tagging not built; and more). Agents build to that table; overturn by editing it. Only two questions remain genuinely open: whole-shelf sharing timing (S3 lean, wants S2 privacy telemetry first) and the jurisdiction checklist before S4 public discovery. S1 needs no decisions at all — its build spec is in SOCIAL.md §16.

---

## 8. Immediate next steps

1. Approve/adjust this plan (especially §3 priorities, §6 pricing, and §7 open questions).
2. Scaffold Expo app + Supabase project (Phase 0).
3. Design the 4 core screens: Search, Bottle Detail, My Bar, Pour Log.
4. Build the bottle-DB seed pipeline.

# Whaikey — Detailed Feature Map

Companion to [PLAN.md](../PLAN.md). This document specifies every feature area in depth: what it does, how the UX flows, what data it touches, where AI is involved, and which phase it ships in. Phases refer to the roadmap in PLAN.md §5.

**Legend:** 🟢 Must (Phase 1) · 🟡 Should (Phase 2–3) · 🔵 Could (Phase 3–4) · ⚪ Backlog

---

## 1. Onboarding & Palate Setup

| # | Feature | Pri | Notes |
|---|---------|-----|-------|
| 1.1 | Auth: Apple / Google / email magic link | 🟢 | Apple sign-in required for iOS App Store anyway |
| 1.2 | Taste onboarding quiz | 🟡 | 5–7 swipeable questions ("Peat: love it / hate it / what's peat?") seeds the palate profile before any pours are logged |
| 1.3 | "Add your first 3 bottles" prompt | 🟢 | Empty-state flow that immediately demonstrates search + My Bar |
| 1.4 | Import from spreadsheet/CSV + competitor exports | 🔵 | Collectors arrive with spreadsheets; AI-assisted column mapping ("this column looks like purchase price"). Support Distiller/Whiskybase export formats — InVintory proved competitor import is a switching weapon (see COMPETITORS.md §7) |
| 1.5 | Experience level selector | 🟡 | Beginner / enthusiast / collector — tunes copy depth, default rating scale, and AI chat tone |

**UX flow (first run):** splash → auth → 3-question mini quiz (skippable) → "scan or search your first bottle" → land on My Bar with one bottle in it. Target: < 90 seconds to first bottle.

---

## 2. Bottle Identification & Database

### 2.1 Search (🟢 Phase 1)
- Instant-as-you-type, < 100 ms, tolerant of misspellings ("lafroig" → Laphroaig) via Postgres trigram + FTS.
- Understands abbreviations and enthusiast slang: "weller sr" → W.L. Weller Special Reserve; "ECBP" → Elijah Craig Barrel Proof (alias table on bottles).
- Filters: category (bourbon/scotch/rye/irish/japanese/world), region, age, ABV, price band, cask type.
- **Semantic search (🟡):** "smoky but sweet under $70" → embedding search over flavor profiles.

### 2.2 Label scan (🟡 Phase 2)
- Camera → vision model → top-3 candidate matches with confidence → confirm-or-correct.
- Handles: batch/vintage variants (flag ambiguity, ask), private single-barrel picks (match parent expression, note the pick), damaged/partial labels (fall back to search pre-filled with what was read).
- Every correction is stored as eval data to improve matching.
- Offline: photo queues and resolves when back online.

### 2.3 Barcode scan (🔵)
- Fallback for retail bottles; UPC → bottle mapping crowdsourced (first scanner confirms match, later scanners benefit).

### 2.4 Bottle detail page (🟢 Phase 1)
Sections, top to bottom:
1. Photo, name, distillery, category chips (region · age · ABV · cask).
2. **Your relationship**: own/tried/wishlist state + your rating + quick actions (log pour, add).
3. Ratings block: your average vs. community average, ratings distribution.
4. **Flavor profile**: mini flavor wheel / radar (community + yours overlaid).
5. Price block: MSRP, street price estimate, your paid price, price trend sparkline (🟡).
6. AI blurb: 2-sentence character summary, generated once and cached.
7. Pairings (🟡), Similar bottles (🟡), Community notes (🔵).

### 2.5 Bottle database & data pipeline (🟢 infra)
- Seed ~2–5k most-common bottles (top bourbon/scotch/rye/irish/japanese) with verified core facts.
- AI-assisted enrichment: descriptions, flavor-profile priors, alias generation — human-reviewed for the top 500, spot-checked beyond.
- User-submitted bottles: instant private use, review queue before global visibility; dedupe detection on submit ("is this the same as…?").
- Every bottle carries an embedding for similarity/recs.

---

## 3. My Bar (Inventory)

### 3.1 Core inventory (🟢 Phase 1)
- Relationship types: **Own** (in My Bar), **Tried** (history), **Wishlist**, and implicit "viewed."
- Per owned bottle: sealed/open/finished, fill level (5-step visual bottle gauge, tap to update), purchase price + date + store, location label (shelf/cabinet/office), backup count.
- Multiple of the same bottle = quantity + per-unit purchase records (different prices/dates).
- Views: grid (bottle photos), list (dense), shelf groups; sort by rating, price, recency, fill level.
- Filters: open vs sealed, category, region, "not touched in 90 days," price band.

### 3.2 Money tracking (🟢 core / 🟡 advanced)
- 🟢 Purchase price capture at add time (optional but nudged), total spent, average bottle price.
- 🟡 **Collection value**: estimated market value per bottle (start: MSRP + user-entered comps; later: price history data), total value vs. total spent, gain/loss.
- 🟡 **Cost per pour**: price ÷ pours logged; shown on pour log ("this pour ≈ $4.10").
- 🟡 Spend dashboard: monthly spend chart, spend by category, most/least expensive open bottle.
- 🔵 Budgets ("$150/mo") with gentle nudges; 🔵 insurance export (PDF/CSV with values).

### 3.3 Bottle lifecycle nudges (🟡)
- Kill list: bottles < 20% full — "finish these."
- Oxidation awareness: open + low fill + long time → "this one may be fading."
- "You haven't poured X in 6 months — still love it?" (feeds recommendations too.)

### 3.4 Collector depth (🔵/⚪, borrowed from competitor analysis)
- 🔵 **Bottle lifecycle statuses** beyond finished: sold / traded / gifted / broken (OnlyDrams pattern) — keeps $ tracking honest.
- 🔵 **Store pick / single-barrel metadata**: barrel number, pick store, batch/proof variants (BarrelBook pattern) — whiskey-specific data wine apps handle badly.
- ⚪ **Infinity bottle** management: blend composition log, pour-in history, evolving profile (Whiskey Shelf pattern).

---

## 4. Pours, Notes & Ratings

### 4.1 Quick pour log (🟢 Phase 1) — *the* core loop
- Entry points: bottle page, My Bar long-press, home-screen "+", (🔵 widget).
- Minimum viable log = bottle + rating: **two taps, < 10 seconds.**
- Optional in the same sheet: serving style (neat/rocks/splash/cocktail), pour size, quick note.
- Everything else is progressive disclosure behind "add detail."

### 4.2 Rating system (🟢)
- Default: 5 stars with half-steps (casual-friendly, Vivino-compatible mental model).
- Settings toggle: 100-point enthusiast scale (stored internally as 0–100 either way).
- Per-pour ratings roll up to a personal per-bottle average; history sparkline shows drift over time.
- Rating calibration (🔵): occasional "which did you like more, A or B?" prompts to de-noise the scale.

### 4.3 Structured tasting notes (🟢)
- Guided template: **Nose / Palate / Finish**, each with tappable flavor chips from the wheel taxonomy + free text.
- Intensity per chip (light tap = present, hold = strong).
- Glassware, water added (drops), time resting — optional metadata.

### 4.4 Voice & freeform notes → AI extraction (🟡 Phase 2, signature feature)
- Talk for 30 seconds about the dram; AI transcribes, then extracts: flavor tags mapped to the wheel, intensity, rating sentiment ("sounds like a 4–4.5 — confirm?"), serving context.
- Extraction is always shown for confirmation — user stays the author.
- Same pipeline handles pasted text (e.g., notes from other apps).

### 4.5 Flights & comparison (🟡)
- Side-by-side mode for 2–4 bottles: shared note sheet, per-bottle columns, final ranking.
- 🔵 **Blind mode**: labels hidden (numbered glasses), reveal after ratings locked. Killer feature for tastings with friends; shareable results card.

### 4.6 Tasting history (🟢)
- Chronological journal of all pours with notes; filter by bottle/category/rating.
- 🟡 AI summaries: "Your take on Ardbeg 10 across 9 pours: consistently 4+, you flag brine and smoked vanilla, scores dip when poured after sherried drams."

---

## 5. Flavor Wheel & Palate Model

### 5.1 The wheel (🟢 Phase 1)
- Two-tier whiskey taxonomy: 8 cores (Fruity, Floral, Grain, Sweet, Woody, Spicy, Peaty/Smoky, Feinty/Sulfury) → ~60 leaf descriptors.
- Roles: **input device** (tap wedges during note-taking), **bottle visualization** (aggregate profile), **comparison overlay** (bottle vs. bottle, you vs. community).
- Custom SVG/Skia component; must feel tactile (haptics on wedge selection).

### 5.2 Palate profile (🟡 Phase 3)
- Weighted flavor-preference vector built from (rating × flavor tags × recency decay).
- Rendered as **"your palate wheel"** — shareable image (organic social growth loop).
- Powers: recommendations, chat grounding, pairing personalization, taste-match % on any bottle page ("87% match for you").
- Evolves visibly: "Your peat tolerance has grown 2× since January" (🔵 palate journey timeline).

---

## 6. Pairings

| # | Feature | Pri | Notes |
|---|---------|-----|-------|
| 6.1 | Per-bottle food pairings | 🟡 | AI-generated from flavor profile, cached per bottle; 3–5 suggestions with one-line rationale each |
| 6.2 | Reverse pairing ("I'm having X") | 🟡 | Searches *your* open bottles first, then wishlist, then general suggestions |
| 6.3 | Cigar pairings | 🔵 | Body/strength matching; large audience overlap |
| 6.4 | Cocktail fit | 🔵 | "Is this a cocktail whiskey?" + 2–3 classic specs suited to its profile |
| 6.5 | Pairing feedback loop | 🔵 | "Did it work?" 👍/👎 on tried pairings; personalizes and improves cached suggestions |
| 6.6 | Occasion menus | ⚪ | "Build a whiskey + dessert flight for 6 people from my bar" (chat-driven) |

---

## 7. Recommendations

### 7.1 New-bottle recommendations (🟡 Phase 3)
- Hybrid engine: content-based (bottle embeddings vs. palate vector) + collaborative signals when community data exists.
- Constraints respected: price band (inferred from purchase history, adjustable), availability realism ("grail mode" off by default), category exploration slider (comfort zone ↔ adventurous).
- **Every rec is explained** in one sentence grounded in the user's actual history.
- Formats: weekly "3 bottles for you" refresh, "similar to this" rail on bottle pages, "cheaper cousin" callouts.

### 7.2 What to pour tonight (🟡)
- From *your open bottles*: considers mood/occasion input, recent pours (variety), fill levels (kill list bias), evening context.
- One-tap re-roll; logging the pour from the suggestion card closes the loop.

### 7.3 Gift & social recs (🔵)
- Gift mode: enter 2–3 bottles the recipient likes + budget → ranked suggestions with explanation card you can send.
- "Bring to a party" mode: crowd-pleaser bias.

---

## 8. AI Chat Concierge

### 8.1 Core chat (🟡 Phase 2)
- Persistent entry points: floating button on main tabs + dedicated tab; deep-linkable from any bottle ("Ask about this bottle" pre-fills context).
- **Tool set:** `search_bottles`, `get_bottle_details`, `get_my_bar`, `get_pour_history`, `get_tasting_notes`, `add_to_wishlist`, `log_pour_draft`, `get_pairings`, `recommend_bottles`, `get_price_info`.
- Write actions (wishlist add, pour log) always show an inline confirmation card before committing.
- Streaming responses; conversation history per session; long-term memory of stated preferences (🔵) with a visible, editable "what Whaikey knows about you" page.

### 8.2 Chat capabilities by phase
- 🟡 Phase 2: whiskey education Q&A, queries over your own data, bottle lookups, price sanity checks ("is $95 fair for Eagle Rare?" → grounded in price data, honest about uncertainty).
- 🟡 Phase 3: recommendation dialogues ("build me a Scotch regions starter flight under $250"), note summarization, collection analysis ("what's my bar missing?").
- 🔵 Phase 4: proactive cards (not push-spam): "You finished your only rye — want replacements under $50?"

### 8.3 Guardrails
- Responsible-drinking stance baked into the system prompt; no consumption encouragement patterns; regional legal-age gate at signup.
- AI never invents prices or availability — tools or "I don't know."
- Per-user rate limits + free-tier caps (see PLAN.md §6 Monetization).

---

## 9. Social & Community (Phase 4+)

| # | Feature | Pri |
|---|---------|-----|
| 9.1 | Community bottle ratings/notes aggregation (anonymous-by-default contribution) | 🔵 |
| 9.2 | Friends: follow, activity feed of pours/ratings (opt-in sharing) | 🔵 |
| 9.3 | Shareable cards: palate wheel, tasting note, flight results, Wrapped | 🟡 *(cards ship earlier than the social graph — they're the growth loop)* |
| 9.4 | Clubs: shared shelves, group blind tastings, meeting notes | ⚪ |
| 9.5 | Crowdsourced local price/availability reports | ⚪ |

---

## 10. Stats, Delight & Retention

- 🟡 **Stats page**: pours over time, category breakdown, average rating by region, spend charts.
- 🔵 **Whiskey Wrapped** (yearly recap, shareable, opt-in on the spend slide 😅).
- 🔵 Badges: regions explored, categories tried, streaks kept honest (no dark-pattern daily-drinking streaks — badge design must respect the guardrails in §8.3).
- ⚪ Distillery passport & map; sample-share tracker (2oz samples, who owes whom); home-screen widgets (tonight's pick, collection value).

---

## 11. Platform & Non-functional Requirements

| Area | Requirement |
|---|---|
| Performance | Cold start < 2 s; search results < 100 ms; pour log round-trip feels instant (optimistic UI) |
| Offline | Pour logging, note-taking, and My Bar browsing work offline; queued sync with conflict resolution (last-write-wins per field) |
| Privacy | Notes/inventory private by default; community contribution is opt-in and anonymized; full export (CSV/JSON) free forever; account deletion = hard delete |
| Accessibility | VoiceOver/TalkBack on all core flows; wheel has a list-mode equivalent; dynamic type |
| Trust & safety | Age gate; responsible-drinking resources; no engagement mechanics that reward consumption frequency |
| Localization | v1 English; schema keeps display strings separable; metric/imperial pour sizes |

---

## 12. Feature dependency graph (build order rationale)

```
Bottle DB ──▶ Search ──▶ Bottle Detail ──▶ Own/Tried/Wishlist ──▶ My Bar ($)
                                   │                                  │
                                   ▼                                  ▼
                             Pour Log + Ratings ◀─────────────── Fill/lifecycle
                                   │
                    ┌──────────────┼────────────────┐
                    ▼              ▼                ▼
              Flavor wheel   Notes (chips)    Tasting history
                    │              │
                    ▼              ▼
              Palate profile ◀─ AI note extraction (voice/freeform)
                    │
        ┌───────────┼──────────────┐
        ▼           ▼              ▼
   Recommendations  Pairings   AI chat (tools over everything above)
        │
        ▼
   Social cards ─▶ Community layer
```

The AI layer deliberately sits *on top of* a working manual core: every AI feature degrades gracefully to a manual equivalent (scan→search, voice notes→chips, recs→browse), so AI failures never block the core loop.

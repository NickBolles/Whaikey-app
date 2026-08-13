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
| 1.4 | Import from spreadsheet/CSV + competitor exports | 🟢 | *Shipped (v1)* at `/import`: paste or upload CSV/TSV → AI-assisted column mapping (heuristic fallback when no key — "this column looks like purchase price") → rows matched by UPC then fuzzy name → user confirms every match before commit. Purchase price/date/store/notes come along; rows with barcodes teach the UPC map. Arbitrary headers means competitor exports (Distiller/Whiskybase-style) work too — InVintory proved competitor import is a switching weapon (see COMPETITORS.md §7). v2: format-specific presets, unmatched rows → user-submitted bottles |
| 1.5 | Experience level selector | 🟡 | Beginner / enthusiast / collector — tunes copy depth, default rating scale, and AI chat tone |

**UX flow (first run):** splash → auth → 3-question mini quiz (skippable) → "scan or search your first bottle" → land on My Bar with one bottle in it. Target: < 90 seconds to first bottle.

---

## 2. Bottle Identification & Database

### 2.1 Search (🟢 Phase 1)
- Instant-as-you-type, < 100 ms, tolerant of misspellings ("lafroig" → Laphroaig) via Postgres trigram + FTS.
- Understands abbreviations and enthusiast slang: "weller sr" → W.L. Weller Special Reserve; "ECBP" → Elijah Craig Barrel Proof (alias table on bottles).
- Filters: category (bourbon/scotch/rye/irish/japanese/world), region, age, ABV, price band, cask type.
- **Semantic search (🟡):** "smoky but sweet under $70" → embedding search over flavor profiles.
- **One search, many doors.** Search is a single feature — one engine, one UI component — reached from several places (Search tab, My Bar "Add bottle", pour-flow bottle picker, chat). The entry point only changes **what happens when you pick a result** (view detail / add to bar / log a pour), stated in the header so it never feels like three different search screens. Never fork the search UX per surface.

### 2.2 Label scan (🟡 Phase 2) — *shipped: dual-mode camera + queue*
- **Dual-mode viewfinder** *(shipped)*: the barcode loop runs continuously while a shutter button captures the label; the frame is confirmed **on-device** (framing check, retake) before anything is uploaded to the vision model.
- **Live on-device guidance** *(shipped)*: the viewfinder coaches in real time from local frame analysis — brightness/sharpness sampling drives "too dark / hold steady / move closer" hints, a green outline flashes over the barcode the detector locked onto, and captures that look dark or blurry get a retake nudge in the confirm sheet. All of it runs on-device; nothing leaves the phone until the user confirms.
- Camera → vision model → top-3 candidate matches with confidence → confirm-or-correct *(shipped)*.
- **Async capture queue** *(shipped)*: every capture resolves in the background — keep shooting bottle after bottle; ambiguous captures pile up as "needs you" items to settle once the shelf is done.
- Handles: batch/vintage variants (flag ambiguity, ask), private single-barrel picks (match parent expression, note the pick), damaged/partial labels (fall back to search pre-filled with what was read).
- Still open: every correction stored as eval data to improve matching; offline photo queueing that resolves when back online.

### 2.3 Barcode/UPC scan (🟢 Phase 1) — *shipped*
The fastest path from a shelf of bottles to a tracked collection — a new user should shelve 50 bottles in a few minutes ("beep… beep… beep"), so this is core onboarding, not a fallback.
- **Rapid batch mode** (`/scan`): camera barcode loop (BarcodeDetector where supported) with manual code entry (hardware wedge scanners work) and label-photo fallback; each confirmed scan lands on the shelf in one round trip — no forms between scans; session tray with undo. Identification runs in an **async queue**, so the next scan never waits for the previous one's network round trip.
- **Resolution chain** (DATA_SOURCES.md §3): own DB (seeded + crowdsourced mappings) → transient external lookup (UPCitemdb → Open Food Facts; results matched against our catalog, never stored) → label photo / inline search.
- **Crowdsourced UPC → bottle mapping**: the first scanner confirms the match, later scanners resolve instantly; confirmations are counted, so shared barcodes (reused across proofs/batches) rank by community consensus. Every scan converts a third-party lookup into first-party data.
- Ambiguity is always confirm-or-correct; a miss teaches the catalog via search or label photo.

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

> **User story:** *"When I open My Bar I'm standing in front of my shelf. I can see at a glance what I own, what each bottle tastes like, and what I thought of it the last time I poured it — without tapping through to anything. Scanning a bottle in and looking at my bar are the two things I do most."*

My Bar is a **top-2 surface** (with scan/search-to-add) — not a list of rows with prices. Flavor and memory are first-class here:

- **Every bottle shows its flavor identity in place** — expand a row and its flavor radar is right there, next to fill level and price.
- **Your notes live on the shelf** — the last thing you wrote about a bottle is visible on its row; quick notes are editable inline, full tasting notes one tap away.
- **The bar itself has a palate** — an aggregate flavor-wheel heat map of the whole library (see 3.5).

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
- Low-fill inventory context can inform a personal recommendation without a standalone finish-first list.
- Oxidation awareness: open + low fill + long time → "this one may be fading."
- "You haven't poured X in 6 months — still love it?" (feeds recommendations too.)

### 3.4 Collector depth (🔵/⚪, borrowed from competitor analysis)
- 🔵 **Bottle lifecycle statuses** beyond finished: sold / traded / gifted / broken (OnlyDrams pattern) — keeps $ tracking honest.
- 🔵 **Store pick / single-barrel metadata**: barrel number, pick store, batch/proof variants (BarrelBook pattern) — whiskey-specific data wine apps handle badly.
- ⚪ **Infinity bottle** management: blend composition log, pour-in history, evolving profile (Whiskey Shelf pattern).

### 3.5 Bar flavor heat map (🟢 Phase 1)
- The full two-tier flavor wheel (8 color-coded families + all leaf subsections, see §5.1) rendered as a **heat map of the library**: the more your bar leans into a flavor, the hotter that wedge/leaf glows — a peat-heavy shelf lights up Peaty/Smoky.
- Heat sources: owned bottles' flavor profiles warm the family wedges; your own tasting-note flavor tags warm the leaf subsections (so pours on tried bottles count too).
- Heat is **relative to your own bar** ("where do I lean"), never an absolute score; hottest leaves are labeled on the wheel and listed as a chip legend.
- Uses: see your collection's personality at a glance, spot gaps ("nothing floral at all"), seed "what's my bar missing?" chat prompts and recommendations (§7).

---

## 4. Pours, Notes & Ratings

### 4.1 Quick pour log (🟢 Phase 1) — *the* core loop
- Entry points: bottle page, My Bar long-press, home-screen "+", (🔵 widget).
- Minimum viable log = bottle + rating: **two taps, < 10 seconds.**
- Optional in the same sheet: serving style (neat/rocks/splash/cocktail), pour size, quick note.
- Everything else is progressive disclosure behind "add detail."
- 🔵 **Visibility is a flag on the pour itself** (default *Only me*), not a separate "post" step — the log you already made is the social object (§9.4). It must never add a tap to the core loop.

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
- 🔵 **Blind mode**: labels hidden (numbered glasses), reveal after ratings locked. Killer feature for tastings with friends; shareable results card. Goes multi-user in §9.9, where each guest logs from their own phone and the reveal produces a group-level comparison against the producer's notes.

### 4.6 Tasting history (🟢)
- Chronological journal of all pours with notes; filter by bottle/category/rating.
- 🟡 AI summaries: "Your take on Ardbeg 10 across 9 pours: consistently 4+, you flag brine and smoked vanilla, scores dip when poured after sherried drams."

---

## 5. Flavor Wheel & Palate Model

### 5.1 The wheel (🟢 Phase 1)
- Two-tier whiskey taxonomy: 8 cores (Fruity, Floral, Grain, Sweet, Woody, Spicy, Peaty/Smoky, Feinty/Sulfury) → ~60 leaf descriptors.
- **Subsections are always color-coded by family** (classic printed-wheel look): each core wedge owns a hue, and its leaves render as graded shades of that hue — a flavor's color is the same everywhere it appears (wheel rings, note chips, legends).
- Roles: **input device** (tap wedges during note-taking), **bottle visualization** (aggregate profile), **library heat map** (My Bar's aggregate palate, §3.5), **comparison overlay** (bottle vs. bottle, you vs. community).
- Custom SVG/Skia component; must feel tactile (haptics on wedge selection).

### 5.2 Palate profile (🟡 Phase 3)
- Weighted flavor-preference vector built from (rating × flavor tags × recency decay).
- Rendered as **"your palate wheel"** — shareable image (organic social growth loop), and the centrepiece of the social profile (§9.1.2).
- Powers: recommendations, chat grounding, pairing personalization, taste-match % on any bottle page ("87% match for you"), and **person-to-person palate match** once there's a graph (§9.7).
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
- From *your open bottles*: considers mood/occasion input, recent pours (variety), and local time-of-day context with a personal, explainable cue.
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

## 9. Social & Community (Phase 4 / S1–S4)

> **Design doc:** [SOCIAL.md](./SOCIAL.md) — thesis, user stories (§5), pages & flow (§6), privacy model, banned mechanics, data model, phasing, decisions, and the agent-ready S1 build spec (§16). This section is the feature-map view of it.

> **User story:** *"I want my friends to see what I tried, what I tasted, and how it compared to the producer's notes — and I want to find whiskey through people whose palate I trust."* (Broken into 17 testable stories in SOCIAL.md §5.)

**The organizing idea:** the bottle is the segment. Strava makes comparison meaningful by having everyone run the same stretch of road; we have everyone taste the same bottle. What varies is the palate, not the performance — so the social layer can be engaging without ever ranking people by how much they drink.

**Phasing (SOCIAL.md §13):** S1 share control + comparison-on-the-link (no graph, implementable now) → S2 friends & Same Dram → S3 conversation & groups → S4 community scale. Every phase ships a loop a user can feel; the sparse-overlap risk is tested by S1, the cheapest phase.

### 9.1 Identity & graph (S2)

| # | Feature | Pri | Notes |
|---|---------|-----|-------|
| 9.1.1 | `@handle` profiles claimed at first social action (not signup — the 90s first-run stays intact) | 🔵 | Display name, avatar, bio, optional home region |
| 9.1.2 | **The profile *is* the palate card** | 🔵 | Palate wheel + signature descriptors + regions/styles covered + 3 recent public notes. Never spend, collection value, or bottle counts |
| 9.1.3 | Follow (asymmetric) with optional approval gate for private accounts | 🔵 | Mutual follow derives "friends", which gates the more intimate surfaces |
| 9.1.4 | Visibility tiers on every object: **Only me** (default) → Friends → Followers → Link → Public | 🔵 | Per-pour flag + a user-settable default that ships as *Only me*. Never retroactive |
| 9.1.5 | Block, mute, report | 🔵 | Day one, not a bolt-on; enforced on every read path in both directions |
| 9.1.6 | Find people: exact handle, invite links, friends-of-friends with matching palates | 🔵 | No contact-book upload through S2 (SOCIAL.md §14 D8) |

### 9.2 Sharing what you tried (S1 — partly shipped, build spec in SOCIAL.md §16)

- **Shipped today:** one-tap share on any pour creates an opaque bearer link (`/s/[code]`) rendering the bottle, rating, serving style and note with an OG image; `noindex`; no prices, no inventory, no other pours.
- **S1 additions:** revocation + a `/sharing` management page (today a link can only be revoked by deleting the pour); an "edited" marker when the underlying note changes; and **comparison on the link** — a signed-in viewer who has tasted the same bottle sees "you both got… / they got — you didn't / you got — they didn't," rendered only for the viewer; a viewer who hasn't gets a one-tap wishlist hook. This is the two-person Same Dram, shipped before any graph exists.
- **S2:** identity behind the link (profile, not a bare name string).
- **Shareable card types** beyond the single pour (S2+): palate card, Same Dram comparison, flight results, Wrapped. Each a non-indexed OG-imaged page.
- Cards are the growth loop and need **no graph at all** — which is why they ship ahead of it.

### 9.3 Same Dram — you vs. the producer vs. your friends (S2, signature) 🔵

The bottle page's comparison view, and the direct answer to *"how did it compare to producer notes?"*

- Three sources in one flavor coordinate space: the **producer's claim** (only when attributed — `hasPublishedProducerFlavorNotes()`), **your notes**, and **each friend's notes**.
- Buckets reuse the shipped calibration vocabulary — **shared** (label named it, you did too), **blind** (label named it, you missed it), **signature** (only you name it) — plus a social one: **contested** (your friends split on it).
- The `substitutes` mapping already computed by `getFlavorCalibration()` becomes person-to-person: *"where Sarah writes clove, you write cinnamon."*
- **Never right/wrong.** A published tasting note is one opinion written once by someone selling the bottle; a friend's note is an opinion too. Calibration against reference points, never accuracy against an answer key.
- No new model call and no new taxonomy — this is the payoff for `src/lib/flavor-wheel.ts` being a shared contract.
- **De-risked in S1:** the two-person version ships on the share page first (§9.2), so overlap gets measured before profiles and follows are built around it.

### 9.4 The comparison stream — a Home module, not a tab (S2) 🔵

- Content is **the pour you already logged**, surfaced by a visibility flag. No separate composer, ever.
- Every card carries a comparison hook: *"you tasted this too — you agreed on peat and brine, you got smoked-meat and he didn't"*, or when you haven't, the discovery version: *"3 friends' notes on this · 82% palate match."*
- **Chronological**, with a light boost for bottles you own/wishlist/have tried. No engagement-optimised ranking — an algorithmically optimised drinking feed is a bad object to have built.
- Lives as a **"From your friends" module on Home** — a sparse early graph (~4 friends ≈ 2 items/week) would make a dedicated tab feel dead. The tab bar doesn't change until a data tripwire says the content justifies it (SOCIAL.md §6.3).
- Designed for the **sparse case first**: four friends produce ~2 items a week, and that must read as calm, not dead.

### 9.5 Reactions, comments & notifications (Cheers S2 · comments S3) 🔵

- One-tap positive reaction: **"Cheers"** (decided, SOCIAL.md §14 D4). Positive-only; no dislike. Ships with the graph in S2.
- Threaded comments (S3, together with the report flow): plain text, `@mentions`, edit window, soft delete, rate-limited, escaped on render.
- Counts live on the object, never aggregated into a person-level score or rank.
- **Notification allow-list:** new follower, cheer/comment on your note, a friend tasted a bottle you've also tasted (batched, ≤1/day), club and flight events you opted into, someone logged a note from a sample you sent. **Banned:** anything mentioning pouring, any "you haven't logged since…", any progress-toward-reward nudge, any "friends drinking now" presence.

### 9.6 Bottle as a social object (S2–S4) 🔵

| # | Feature | Pri | Notes |
|---|---------|-----|-------|
| 9.6.1 | Community ratings/notes aggregation (anonymous-by-default contribution) | 🔵 | Friends' ratings shown as a separate labelled row — never mixed into the public average |
| 9.6.2 | **Community flavor consensus vs. the producer's claim** (S4 — needs volume) | 🔵 | *"The label says honey; 71% of drinkers say caramel."* Requires shared taxonomy + attributed producer notes — structurally hard for anyone else to copy |
| 9.6.3 | "Others who tasted this" | 🔵 | Opt-in, capped, ordered by palate match — never by who drinks it most |
| 9.6.4 | Crowdsourced local price/availability reports | ⚪ | Ranges and dates, never false precision |

### 9.7 Taste twins & palate match (S3) 🔵

- Cosine similarity over palate vectors → a match % on profiles and friends' notes.
- The collaborative signal a purely content-based recommender can't produce: friends' ratings weight recommendations, and explanations get concrete — *"your two closest palate matches both rated it 4.5+."*
- Match % is a property of a **relationship**, never a rank. There is no "top tasters" board.
- Cached on a schedule (`user_palate_similarity`), not computed per request.

### 9.8 Clubs (S3) 🔵

- Create/join a club (private, invite-link, or public); roles owner/member.
- Club feed, **shared shelf** (opt-in per bottle, prices stripped), club-only notes, and a **club palate wheel** — *"this club leans peaty and owns nothing floral."*
- Aim at the group of 4, not the community of 4,000: small-group belonging is Strava's strongest retention mechanic (club members ~3.5× more likely to still be active at 12 months).

### 9.9 Blind flights, together (S3 — can lead the phase) 🔵

Extends §4.5's blind mode into a multi-user session — the marquee group feature.

- Host builds the flight from their bar or a shared pool; the app assigns blind letters; guests log ratings + wheel notes per slot from their own phones; host (or a timer) triggers the reveal.
- Reveal screen: aggregate score per bottle, who guessed what, and a **group Same Dram** — the whole table's notes against the producer's.
- Shareable results card; stored in club history.
- Needs a host and guests, **not clubs** — no dependency on §9.8, so flights can ship first within S3. Hosting is free at any table size: every guest at the table is an install, so the flight night is the app's strongest acquisition loop (SOCIAL.md §10).
- Deliberately better in person, which is the right thing for an alcohol app to optimise: shared, occasion-based drinking rather than solo daily logging.

### 9.10 Bottle shares & samples (S3) 🔵

- Track the 2 oz you sent a friend (giver, receiver, bottle, amount, state) and link the pour they log from it.
- *"Someone tasted the sample you sent — here's what they got"* is the warmest notification this app can send, and it rewards generosity rather than consumption.

### 9.11 What social will never do

Hard rules, enforced in review (SOCIAL.md §3.1) and grounded in the published critique of Untappd's gamification, which found volume, streak, ABV and time-of-day badges unchanged after five years of ethical criticism:

1. No consumption metric (pours, volume, ABV, consecutive days) displayed to another user, ranked, or built into a badge, level, or notification.
2. No streaks and no drinking-linked reactivation nudges.
3. No leaderboard sorted by a consumption quantity — including note counts, which are a consumption proxy (public aggregates must be a **rate**, a bounded **set**, or a coarse **bucket**).
4. No time-of-day, venue-frequency, or strength achievements; no public "drinking now" presence.
5. **Money never crosses a social boundary** — purchase price, collection value, spend and cost-per-pour are structurally absent from social projections. Privacy *and* safety: a public high-value collection is a burglary target.
6. **Recovery-aware exit:** one tap makes everything private and switches social off entirely, with the private journal fully intact. Stepping back from drinking must never mean losing your notes.

**Guardrail metric (smoke alarm, not circuit breaker):** pours logged per active user per week is watched, cohort-adjusted, across every social release. The enforcement is the mechanic bans above, applied in review; the metric verifies they worked. A sustained rise triggers investigation — logging isn't drinking, and better capture raises logged pours while drinking is flat — but if a genuine frequency rise traces to a specific social mechanic, that mechanic gets fixed or pulled, and "engagement is up" never excuses it (SOCIAL.md §12).

---

## 10. Whiskey School — Learning, Quizzes & Guided Tastings

Inspired by Vivino's "Wine Adventures" (gamified guided tasting journeys, a Premium hook) and Dram's Duolingo-style lessons — but with a twist neither has: **our lessons are grounded in your actual bar and your actual pours**, not generic content.

### 10.1 Micro-lessons (🟡 Phase 3)
- 2–3 minute cards: "What is mash bill?", "Why does proof matter?", "Sherry casks explained", "Scotch regions", "How to nose a glass."
- AI-personalized ordering: lessons surface based on what you actually drink ("You own 4 wheated bourbons — here's why wheat changes the flavor").
- Progressive tracks: Whiskey 101 → Bourbon Deep Dive → Scotch Regions → Cask Science → Blind Tasting Skills.
- Content pipeline: expert-reviewed base curriculum + AI-generated personalization layer (AI never invents facts into lessons; it selects and contextualizes reviewed content).

### 10.2 Quizzes & knowledge checks (🟡 Phase 3)
- End-of-lesson quizzes (3–5 questions, Duolingo-style); spaced-repetition review of missed concepts.
- **"Guess from your bar"** mode: quiz questions generated from bottles you own ("Which of YOUR bottles is a wheated bourbon?") — zero-content-cost, infinitely personal.
- XP, levels, badges tied to knowledge (regions mastered, styles identified) — never to consumption volume (guardrails §8.3 apply: streaks/rewards must not incentivize drinking).

### 10.3 Guided tastings — where learning meets the glass (🔵 Phase 3–4)
- Structured tasting exercises using a bottle you own: step-by-step nosing/tasting prompts, wheel input at each step, then compare your notes to community/expert consensus.
- **Palate training**: "Can you find the vanilla?" exercises; blind-mode variants with a friend pouring.
- **Taste-along flights**: curated multi-bottle journeys ("The 5 Scotch regions") — works with what you own, suggests affordable fills for gaps (a natural, honest commerce hook later).
- Calibration payoff: guided tastings feed the palate profile with higher-quality signal than casual pours.

### 10.4 AI tutor mode (🔵)
- The chat concierge in teaching mode: Socratic follow-ups after quizzes, "explain like I'm new" toggles, and pour-side coaching ("You're drinking the Redbreast 12 — want the 60-second version of what pot still means?").

**Monetization fit:** free tier gets Whiskey 101 + occasional quizzes; full tracks, guided tastings, and tutor mode are Pro (mirrors Vivino gating Wine Adventures behind Premium — see PLAN.md §6).

**Retention fit:** lessons and quizzes give non-drinking-day engagement — the app has a reason to open even when you're not pouring, without any consumption-incentive mechanics.

---

## 11. Stats, Delight & Retention

- 🟡 **Stats page**: pours over time, category breakdown, average rating by region, spend charts.
- 🔵 **Whiskey Wrapped** (yearly recap, shareable, opt-in on the spend slide 😅).
- 🔵 Badges: regions explored, categories tried, streaks kept honest (no dark-pattern daily-drinking streaks — badge design must respect the guardrails in §8.3).
- ⚪ Distillery passport & map; sample-share tracker (2oz samples, who owes whom); home-screen widgets (tonight's pick, collection value).

---

## 12. Platform & Non-functional Requirements

| Area | Requirement |
|---|---|
| Performance | Cold start < 2 s; search results < 100 ms; pour log round-trip feels instant (optimistic UI) |
| Offline | Pour logging, note-taking, and My Bar browsing work offline; queued sync with conflict resolution (last-write-wins per field) |
| Privacy | Notes/inventory private by default; community contribution is opt-in and anonymized; full export (CSV/JSON, including social data) free forever; account deletion = hard delete with social rows cascading. Visibility is never raised by the system (the owner may raise it explicitly), share links are enumerable and revocable, and money data never enters a social projection (§9.11, SOCIAL.md §8) |
| Accessibility | VoiceOver/TalkBack on all core flows; wheel has a list-mode equivalent; dynamic type |
| Trust & safety | Age gate; responsible-drinking resources; no engagement mechanics that reward consumption frequency |
| Localization | v1 English; schema keeps display strings separable; metric/imperial pour sizes |

---

## 13. Feature dependency graph (build order rationale)

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
        ▲
        │            Flavor wheel ──▶ Producer calibration ─┐
        │                  │                               │
        │                  ▼                               ▼
        │          Share links + link comparison (S1) ──▶ Profiles + follow graph (S2)
        │                                        │
        │                                        ▼
        └──── Taste twins (S3) ◀──── Same Dram + Home friends module (S2)
                                                 │
                                    ┌────────────┴────────────┐
                                    ▼                         ▼
                         Blind flights · Clubs (S3)    Community layer (S4)
```

Two things to read off the social half: **share links and the two-person comparison need no graph** (so they ship first, seed the graph, and measure note overlap before anything else is built), and **Same Dram is downstream of the flavor taxonomy plus producer calibration** — which is why a competitor with a feed but no shared descriptor space can't copy it.

The AI layer deliberately sits *on top of* a working manual core: every AI feature degrades gracefully to a manual equivalent (scan→search, voice notes→chips, recs→browse), so AI failures never block the core loop.

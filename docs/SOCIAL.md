# Whaikey — Social Plan

Companion to [PLAN.md](../PLAN.md), [FEATURES.md](./FEATURES.md) and [COMPETITORS.md](./COMPETITORS.md). This is the design doc for turning Whaikey from a private tasting journal into something friends use *together* — without becoming a drinking leaderboard.

**The ask, in the user's words:** *"share with my friends what I tried, what I tasted and how it compared to producer notes. Strava does this well. It would help me discover whiskey better and connect with some friends better."*

**TL;DR:** Strava's magic isn't the feed — it's that everyone runs the *same segment*, so comparison is meaningful and identity is earned. In whiskey the shared course is **the bottle**, and the thing being compared is **your palate**, not your consumption. That single substitution gives us a social product that is genuinely differentiated *and* structurally compatible with our responsible-drinking guardrails, because it rewards discernment and breadth rather than volume and frequency. Everything below follows from it.

**How to read this doc:** §1–§4 are the argument. §5 (user stories) and §6 (pages & flow) are what we're building and where it lives. §7 details each feature. §8–§12 are the operating rules. §13 is the phase plan, §14 the decisions, §15 the risks — and **§16 is the agent-ready build spec for S1**, which is implementable today with zero open decisions.

---

## 1. Why social, why now

Three arguments, in order of strength:

1. **Discovery gets better with people in it.** Our recommendation engine is content-based (palate vector × bottle embeddings). Collaborative signal — "people whose palate matches yours rated this 4.5" — is the standard cold-start fix and we cannot generate it from one user. A friend graph is the highest-quality version of that signal, because trust is already established.
2. **The comparison we already built is only half-finished.** `getFlavorCalibration()` (shipped, #50) lines your flavor tags up against the producer's and tells you *"you call clove cinnamon."* That is a fascinating thing to see alone and a *much* better thing to see next to a friend who tasted the same bottle. The third column — friends — is the missing one.
3. **Retention on non-drinking days.** Same argument as Whiskey School (FEATURES.md §10): the app needs reasons to open that aren't "pour a drink." Reading what your friends thought is the biggest one, and it carries zero consumption incentive.

The counter-argument, stated honestly: **social is not our wedge.** Distiller, Whiskybase, DramIt and Whiskey Social all have feeds already (COMPETITORS.md §2). Shipping "a feed" buys nothing. We ship social *only* in the form that is downstream of our actual moat — the flavor taxonomy, the calibration engine, and the palate model. A generic activity stream is explicitly out of scope; see §7.3 for what replaces it.

---

## 2. The thesis: what Strava actually gets right

Strava is often mis-copied as "a feed with likes." The mechanics that carry it are narrower and more specific:

| Strava mechanic | What it actually does | Whiskey analog | Verdict |
|---|---|---|---|
| **Segments** — a shared stretch of road everyone rides | Makes efforts *comparable*. Without a shared course a feed is just noise. | **The bottle.** Two people who both drank Lagavulin 16 have run the same segment. | **Adopt — this is the whole design.** |
| **Kudos** | Cheap, positive-only, one-tap acknowledgement. No downvote, so the feed stays warm. | One-tap "Cheers" on a note or a pour. | Adopt (positive-only, no dislike). |
| **Comments** | Where the actual conversation happens; low volume, high value. | Same, threaded under a note. | Adopt. |
| **Clubs** | Small-group belonging. Club members are ~3.5× more likely to still be active at 12 months. | Tasting clubs / whisky societies / a group chat that owns a shared shelf. | Adopt — and it's where blind flights live (§7.9). |
| **Following (asymmetric)** | Low-friction graph growth; you don't need permission to admire someone. | Follow a friend or a taster whose palate you rate. | Adopt, with an approval option for private accounts. |
| **Activity as content** | The workout you did anyway becomes the post. Zero extra authoring cost. | The pour you logged anyway becomes the post. | Adopt — sharing must be a visibility flag on an existing pour, never a separate "compose" flow. |
| **KOM/QOM leaderboards** | Ranks people by performance on the segment. | Ranking people by… drinking the most of a bottle. | **Reject.** No ranking of people by consumption, ever. |
| **Local Legend** (most *frequent* completions) | Explicitly rewards repetition. | Rewards drinking the same bottle most often. | **Reject outright.** This is the single most dangerous mechanic to port. |
| **Streaks / weekly volume goals** | Habit formation via consecutive-day pressure. | Consecutive drinking days. | **Reject outright.** |
| **Heatmaps / route maps** | Location as content. | Bar and home location as content. | Reject as a default; venue tagging is opt-in and coarse (§8). |

### 2.1 The substitution that makes it work

> On Strava the segment is fixed and the *athlete* varies, so the interesting question is **"who is fastest?"**
> On Whaikey the bottle is fixed and the *palate* varies, so the interesting question is **"what did you get that I didn't?"**

There is no better/worse axis in that question, which is why the social layer can be competitive-feeling without being a consumption contest. The unit of status is **the quality and distinctiveness of your palate** — how precisely you describe, how wide you range, how often you name something the label named and your friends missed. That's earnable without drinking more, and it maps directly onto data we already compute.

---

## 3. The line we will not cross

The nearest real-world precedent for "Strava for drinking" is Untappd, and the research on it is not kind. A 2026 longitudinal analysis of Untappd's gamification ([arXiv 2601.04841](https://arxiv.org/html/2601.04841v1)) found the ethically-grey mechanics identified in 2020 essentially unchanged five years later, and named the specific offenders:

- **ABV badges** ("Sky's the Limit", 10%+ beers) — ties achievement to a risky health behaviour.
- **Frequency/streak badges** ("Daily Checker", "Power Month", "Drinking Your Paycheck") — turn quantity into accomplishment.
- **Quantity badges** ("Take It Easy", 12 in a day; cumulative 15,000+ milestones) — raw volume as visible status.
- **Time-of-day badges** ("Top of the Mornin'", "Liquid Lunch") — normalise drinking in inappropriate contexts.
- **Venue badges** — combine privacy exposure with encouragement to drink in more places, and blur the line between engagement and marketing.
- **Nudge notifications** — telling a user they are "two beers away" from the next level.

Their conclusion is the design constraint we adopt: symbolic disclaimers don't work; the *mechanics themselves* have to be built differently.

A scoping note so this section stays sharp: these bans are the load-bearing guardrails, and they are **bans on mechanics, enforced in review** — that's the whole enforcement model. Process guardrails elsewhere in this doc (phase gates, metrics, re-checks) are cheaper to get wrong and are deliberately kept lighter; see §12 and §13 for what was trimmed and why.

### 3.1 Banned mechanics (hard rules, no exceptions, enforced in review)

1. No metric that counts pours, volume, ABV, or consecutive days is ever **displayed to another user**, ranked, or used in a badge, level, or notification.
2. No streaks. No "you haven't logged in 3 days" reactivation nudges tied to drinking.
3. No leaderboard whose sort key is a consumption quantity — including note and rating counts, which are consumption proxies (§3.3).
4. No notification that suggests pouring, or that implies progress toward a reward if the user drinks.
5. No time-of-day, venue-frequency, or strength-based achievements; no public "who's drinking right now" presence.

### 3.2 Encouraged mechanics (the substitutes)

| Instead of rewarding… | We reward… | Data it uses |
|---|---|---|
| Volume | **Breadth** — regions, styles, cask types, distilleries *encountered* (a 15 ml sample at a bar counts the same as a bottle) | `tried` relationships |
| Frequency | **Precision** — descriptor vocabulary size, agreement with published notes, blind-tasting calibration | `tastingNotes.flavorTags`, `getFlavorCalibration()` |
| Being first/most | **Being useful** — notes others found helpful, a substitute mapping that made a friend go "oh, that's what I taste" | Cheers/comments received |
| Drinking a rare bottle | **Sharing a rare bottle** — sample swaps, pours poured for others, hosting a flight | Bottle-share tracker, flight hosting |

Note that every one of these is satisfiable by someone drinking *less* whiskey more attentively. That's the test: **if a mechanic can't be won by a moderate drinker, it doesn't ship.**

### 3.3 The subtle one: note count is a consumption proxy

"Most notes written" looks like a discernment metric and is really a drinking metric. One rule covers it: **absolute activity counts never rank or sort people.** Coarse buckets as a profile trust signal ("100+ notes") are fine; so are rates and ratios (agreement %, distinct descriptors per note) and bounded sets (regions covered).

---

## 4. What already ships (the foundation)

We are not starting from zero. Shipped today:

| Piece | Where | What it gives social |
|---|---|---|
| **Public pour links** | `pourShares` table, `/s/[code]`, `POST /api/pours/[id]/share`, `PourShareButton` on the history timeline | An opt-in, bearer-token public projection of one pour + note, with an OG image. Already carefully scoped: no prices, no inventory, no other pours. |
| **Producer-note calibration** | `getFlavorCalibration()` in `src/lib/bar.ts` | The shared/blind/signature buckets and the `substitutes` mapping — the "how it compared to producer notes" half of the ask, already computed. |
| **Attributed producer claims** | `bottles.producerFlavorTags` + `producerFlavorSourceUrl` + `producerFlavorSourceLabel`, gated by `hasPublishedProducerFlavorNotes()` | A producer claim is only displayable with a source. This rule extends unchanged into every social surface. |
| **Shared flavor taxonomy** | `src/lib/flavor-wheel.ts` (8 wedges, ~55 leaves) | The reason cross-user comparison is even possible: everyone's notes are in the same coordinate space. Free-text notes could never be compared this way. |
| **Palate model** | `src/lib/palate.ts`, palate wheel | The input to taste-match between people (§7.7). |

**Gaps in the shipped share flow** that this plan closes: a share link cannot be revoked (only deleting the pour revokes it, via cascade); there is no per-pour visibility concept (a pour is private or bearer-public, nothing between); the share page has no identity behind it (a name string, not a profile); and nothing links two people who shared notes on the same bottle.

---

## 5. User stories

The stories are the contract: each phase in §13 ships a coherent subset, and §16's build spec maps to them by number. Acceptance criteria are deliberately terse — one sentence that a test can be written against.

### Sharing & the first comparison (S1)

- **US-1 — Compare on the link.** *As a taster, when I open a friend's shared pour link and I've tasted the same bottle, I want to see how our notes compare, so the link starts a conversation instead of just showing a card.*
  ✓ Signed-in viewer with notes on the bottle sees three groups: descriptors you both named, theirs you didn't, yours they didn't. Viewer's own notes are shown only to the viewer — nothing about the viewer is revealed to the sharer or stored.
- **US-2 — Revocable sharing.** *As someone who shared a link I regret, I want to revoke it instantly and see every link I've created, so sharing never feels irreversible.*
  ✓ A "Shared links" page lists every active link with bottle + date; revoke makes the link 404 immediately; the pour itself is untouched.
- **US-3 — Discovery hook.** *As a viewer who hasn't tried the bottle, I want to wishlist it in one tap from the share page, so a friend's note becomes my next bottle.*
  ✓ Signed-in viewer without notes on the bottle sees "Add to wishlist" instead of a comparison; tapping it creates the wishlist relationship without leaving the page.

### Identity & friends (S2)

- **US-4 — Palate-card profile.** *As a user, I want a profile that shows my palate — wheel, signature descriptors, regions covered — not a wall of pours, so following me is a decision about taste, not volume.*
  ✓ `/u/[handle]` renders palate wheel + signature descriptors + regions/styles covered + up to 3 public notes; never spend, value, or pour counts.
- **US-5 — Follow.** *As a user, I want to follow a friend (with approval if their account is private), so their notes can reach me.*
  ✓ Follow, unfollow, approve/deny requests; mutual follow derives "friends."
- **US-6 — Visibility without friction.** *As a logger, I want to choose who can see a pour at log time without extra taps in the core loop.*
  ✓ Visibility selector lives behind "add detail" on the pour sheet; default is my saved preference (ships as Only me); logging speed is unchanged.
- **US-7 — Friends on Home.** *As a user, I want to see my friends' recent notes on Home, each framed as a comparison or a discovery, so opening the app is interesting on days I don't pour.*
  ✓ Home shows a "From your friends" module; each card carries "you tasted this too" or "add to wishlist"; empty state invites, doesn't nag.
- **US-8 — Same Dram.** *As a taster, on a bottle page I want to see me vs. the producer vs. my friends in one flavor space — "where Sarah writes clove, you write cinnamon."*
  ✓ Bottle page section renders shared/blind/signature buckets plus contested descriptors across producer + self + friends who opted their notes visible.
- **US-9 — Cheers.** *As a reader, I want to acknowledge a friend's note with one positive tap.*
  ✓ Cheers on a visible note; count shows on the note, never aggregates to a person score.
- **US-10 — Block.** *As a user, I want to block someone so we are invisible to each other everywhere.*
  ✓ Block removes both directions from every social read path, immediately.
- **US-11 — Step back.** *As someone changing my relationship with drinking, I want one tap that makes everything private and turns social off, keeping my journal intact.*
  ✓ A single action revokes/hides all shared surfaces and unlists the profile; nothing is deleted; reversible.

### Conversation & groups (S3)

- **US-12 — Comments.** *As a friend, I want to reply under a note, because "how did you get smoked meat out of this?" is the whole point.*
  ✓ Threaded comments on visible notes; edit window; soft delete; report action.
- **US-13 — Clubs.** *As a tasting-club member, I want a private group with a shared shelf and a club palate wheel, so the club has a home.*
  ✓ Create/invite/join; opt-in per bottle to the shared shelf; club feed and wheel; prices never shown.
- **US-14 — Blind flight night.** *As a host, I want to build a blind flight my guests rate from their own phones, with a reveal at the end, so tasting night runs itself.*
  ✓ Host builds flight → blind letters → guests log rating + wheel notes per slot → reveal shows scores, guesses, and the group vs. the producer's notes; shareable results card.
- **US-15 — Samples.** *As a sample sender, I want to see the note my friend wrote from the 2 oz I sent them.*
  ✓ Sample record links giver → receiver → the receiver's pour; giver is notified when the note lands.
- **US-16 — Taste twins.** *As a user, I want recommendations to lean on people who taste like me, with the reason stated.*
  ✓ Palate-match % on profiles and notes; recs can cite "your two closest palate matches rated it 4.5+."

### Community scale (S4)

- **US-17 — Consensus vs. the label.** *As anyone, I want to see what drinkers collectively taste vs. what the label claims — "the label says honey; 71% say caramel."*
  ✓ Aggregate flavor consensus renders on bottle pages once a minimum sample is met; contributions are opt-in and anonymised.

---

## 6. Pages & flow

The feature set has to land somewhere. Today's surface map, then what social changes about it.

### 6.1 The app today

- **Tab bar (5 slots):** Home `/` · My Bar `/bar` · **＋ New** (quick actions: log a pour `/pour`, scan `/scan`, find a bottle `/search`) · Search `/search` · Chat `/chat`.
- **Secondary surfaces:** bottle detail `/bottles/[id]`, pour history `/history`, learn `/learn`, import `/import`, share page `/s/[code]`, sign-in `/sign-in`.
- Home is already a dashboard (greeting, start-with-your-shelf, Whiskey School, recent pours) — it has room for one more module and a natural slot for it.

### 6.2 Where social attaches

| Surface | Change | Phase |
|---|---|---|
| `/s/[code]` | Viewer-side comparison block (US-1) and wishlist CTA (US-3) for signed-in viewers; unchanged for signed-out | S1 |
| `/sharing` *(new)* | "Shared links" management: list + revoke (US-2). Linked from `/history` and from the share confirmation. Grows the "make everything private" switch in S2 (US-11) | S1 |
| `/pour` (log sheet) | Visibility selector behind "add detail" (US-6) — never a new tap in the core loop | S2 |
| `/u/[handle]` *(new)* | Profile = palate card (US-4) | S2 |
| `/friends` *(new)* | Follow management: requests, following, followers, blocks (US-5, US-10). Reached from Home module header and own profile — **not a tab** | S2 |
| `/` Home | "From your friends" module (US-7) — this *is* the feed; see §6.3 | S2 |
| `/bottles/[id]` | **Same Dram** section (US-8): friends column added to the existing producer-calibration view | S2 |
| `/history` | Per-pour visibility badge + change control on each row | S2 |
| `/clubs`, `/clubs/[id]` *(new)* | Club home: members, shared shelf, club wheel, club feed (US-13) | S3 |
| `/flights/[id]` *(new)* | Blind flight session: host controls, guest logging, reveal (US-14) | S3 |

### 6.3 The nav decision: the feed is a Home module, not a tab

With a realistic early graph (~4 friends), the feed produces **~2 items a week**. A dedicated tab for that is a dead room — the worst first impression a social layer can make. So:

- The comparison stream ships as a **module on Home**, designed sparse-first: 1–3 cards, then "see all" (which is just the module, longer). Home is already the "what's new" surface; friends' notes are the best "what's new" there is.
- The tab bar does not change in S1–S3. No fifth destination fights for a slot until the content justifies it.
- **Promotion tripwire, decided by data not taste:** if the median weekly-active user has 5+ friends with notes and the friends module is a top-3 tapped element on Home, promote it to a tab (Search is the candidate to fold into ＋, where it already appears). Until then, no.

One more flow rule, restated from §7.3 because it's structural: **there is no composer anywhere.** Sharing is a property of the pour you already logged (log sheet, history row, bottle page). The moment a "create post" button exists, we're building a feed product, and we said we wouldn't.

---

## 7. The feature set

### 7.1 Identity — profile & palate card (S2)

- `@handle` (unique, immutable-ish, claimable at first social action — not at signup, which stays a 90-second path), display name, avatar, one-line bio, optional home region.
- **The profile *is* the palate card**, not a wall of pours: your palate wheel, your top signature descriptors, regions/styles covered, and 3 recent public notes. This is the shareable artifact (FEATURES.md §9.3) and the thing that makes a follow decision easy.
- Public-profile toggle; a private profile is discoverable only by exact handle.
- Profiles never show: spend, collection value, purchase prices, bottle counts by quantity, or anything from §3.1.

### 7.2 The graph — follow, friends, and why we're picking follow (S2)

**Decision: asymmetric follow, with an optional approval gate.** Reasons: it's the lower-friction growth mechanic (Strava, Instagram), it lets a beginner follow an expert taster without a reciprocal relationship, and mutual-follow can be *derived* ("friends" = you follow each other) to gate the more intimate surfaces. Private accounts flip follows into requests.

- Visibility tiers used everywhere: **Only me** (default) → **Friends** (mutual follows) → **Followers** → **Anyone with the link** → **Public**.
- Finding people: exact-handle search, invite links, **profile QR codes** (show yours in person; scanning opens a preview-then-confirm add screen), **exact phone lookup** (double-opt-in, keyed-hash storage, rate-limited; §14 D8 as amended), "friends of friends who drink what you drink," and same-bottle discovery (§7.6). No contact-book/bulk import — ever (§14 D8).
- Every add path — handle, phone, QR — lands on the same confirm screen (`/add/[handle]`): identity preview first, then an explicit Follow tap. Nothing follows on lookup alone.
- Blocking is first-class from day one of the graph, enforced on every read path in both directions. (Reporting ships with comments in S3 — see §11 for why.)

### 7.3 The stream — a Home module, not a feed product (S2)

The feed is where most social products go generic. Ours is constrained by one rule: **a card is only interesting if it lets you compare.** So the card is not "Nick drank a thing":

```
┌──────────────────────────────────────────────────────────┐
│ @nick · Lagavulin 16 · neat · 2 days ago            ★4.5 │
│                                                          │
│ "Campfire and iodine, but sweeter than I remembered."    │
│                                                          │
│ ● peat  ● brine  ● vanilla  ○ dried-fruit               │
│   └─ shared with the label ──┘  └─ his own ──┘           │
│                                                          │
│ You tasted this too: you agreed on peat + brine,         │
│ you got smoked-meat, he didn't.        [Compare notes →] │
└──────────────────────────────────────────────────────────┘
```

- **Content = the pour you already logged**, surfaced by a visibility flag. No separate composer, ever.
- The "you tasted this too" line is computed from your own tasting notes on the same bottle. If you haven't tried it, the line becomes the discovery hook instead: *"3 of your friends' notes on this — 82% palate match with you"* → wishlist in one tap.
- **Chronological** with a light relevance boost (bottles you own/wishlist/have tried rank up). No engagement-optimised ranking — we are not fighting for time-on-app, and an algorithmic drinking feed is a bad object to have built.
- Lives on Home (§6.3). Empty and low-volume states matter more than the full state: with 4 friends this stream has ~2 items a week, and it must feel calm rather than dead. Design it for the sparse case first (DESIGN.md rules apply).

### 7.4 Same Dram — the signature surface (S2, the marquee)

The bottle page gains a comparison view: **you vs. the producer vs. your friends**, all in the same flavor coordinate space.

- Three-column (or overlaid-wheel) view of the same ~55 leaf descriptors: what the label claims (attributed, per `hasPublishedProducerFlavorNotes()`), what you wrote, what each friend wrote.
- Reuses the shipped bucket vocabulary: **shared** (label named it, you did too), **blind** (label named it, you missed it), **signature** (only you name it) — now with a fourth, social bucket: **contested** (a descriptor your friends split on).
- The payoff line is the same one calibration already produces, pointed at a person instead of a label: *"Where Sarah writes clove, you write cinnamon."* That is the sentence that makes someone screenshot the app.
- **Never framed as right/wrong.** The existing rule stands verbatim: a published tasting note is one opinion written once by someone selling the bottle. Friends' notes are opinions too. This is calibration against reference points, never accuracy against an answer key.
- Feeds directly back into discovery: a friend whose blind spots mirror yours is a strong recommendation source; one whose signature descriptors you consistently also find is a **taste twin** (§7.7).
- **De-risked in S1:** the two-person version of this comparison ships on the share page first (US-1), with no graph — so we learn whether note overlap is common enough to carry the surface before building profiles and follows around it (§15, sparse overlap).

### 7.5 Reactions, comments & notifications (Cheers S2 · comments S3)

- One-tap positive reaction: **"Cheers"** (§14 D4). Positive-only; there is no dislike. Ships with the graph in S2 — it's a day of work and it makes the first social release feel alive.
- Comments (S3): threaded on a note, plain text, mentions with `@handle`, edit window, soft delete. Comments arrive with the report flow (§11) — conversation and moderation ship together.
- Reaction/comment counts are shown on the object, never aggregated into a person-level score or rank.
- **Notification policy (applies from S2):**
  - **Allowed:** someone followed you; someone cheered/commented on your note; a friend tasted a bottle you've also tasted (batched); flight/club events you opted into; a sample recipient logged their note.
  - **Banned (§3.1 restated):** anything that suggests pouring, any "you haven't logged since…", any progress-toward-reward nudge, any "your friends are drinking right now."
  - Defaults: follows and direct replies on; everything else daily-batched or off. Full per-category control. Beyond that, tuning (quiet hours, batch windows) is a product-quality concern, not a guardrail — iterate freely.

### 7.6 The bottle as a social object (S2 → S4)

Every bottle page gets a community section that is the segment leaderboard's honest cousin:

- Community rating distribution (already planned, FEATURES.md §2.4) plus **friends' ratings surfaced first** (S2).
- **Community flavor consensus** vs. the producer's claim (S4 — needs volume) — an aggregate-level version of calibration that is genuinely novel: *"The label says honey. 71% of drinkers say caramel."* Nobody else can compute this, because nobody else has a shared taxonomy plus attributed producer claims.
- "Others who tasted this" is capped, opt-in, and ordered by palate match — never by who drinks it most.
- Contribution to community aggregates is opt-in and anonymised by default (FEATURES.md §9.1 stands).

### 7.7 Taste twins & palate match (S3)

- Cosine similarity between palate vectors → a **match %** shown on profiles and friends' notes ("87% palate match").
- Uses: friend suggestions, weighting friends' ratings in recommendations (collaborative signal, finally), and explanation text — *"recommended partly because your two closest palate matches both rated it 4.5+."*
- Guardrail: match % is a **relationship** property, never a rank. There is no "top tasters" list.
- Computed on a schedule and cached (`user_palate_similarity`), not per-request.

### 7.8 Clubs (S3)

Small groups are the retention mechanic worth copying wholesale.

- Create a club (name, avatar, private/invite/public), invite by link, roles owner/member.
- Club surfaces: a club feed (same comparison card), a **shared shelf** (bottles members own, opt-in per bottle), club-only notes, and a club palate wheel — *"this club leans peaty, and nobody here has anything floral."*
- Real-world fit: whisky societies, a bottle-share group, four friends in a group chat. Aim at the group of 4, not the community of 4,000.

### 7.9 Blind flights — the group killer feature (S3, can lead the phase)

Already specified in PLAN.md §2.8 and FEATURES.md §4.5; social makes it real. Host picks bottles, app assigns blind letters, each guest logs ratings + wheel notes from their own phone, host triggers the reveal, and everyone sees:

- Aggregate scores per bottle, who guessed which bottle was which, and a group-level Same Dram view (§7.4) — including how the whole table compared to the producer's notes.
- A shareable results card (the growth loop) and a club-history record.
- Flights need a host and guests, **not clubs** — they can ship first within S3, and a great flight night is the strongest install loop the app has (every guest at the table signs up to participate). Which is also why hosting is free at any table size (§10).
- This is the one social feature that is *better in person*, which is exactly the kind of social feature an alcohol app should be optimising for: it moves engagement toward shared, occasion-based, moderate drinking and away from solo daily logging.

### 7.10 Sharing outward (S1 — extends what's shipped)

- Keep the bearer-link model (`/s/[code]`) and **add revocation** plus a "my shared links" management page. Bearer links are the safest primitive we have; they should be fully controllable.
- Extend beyond a single pour (S2+): shareable **palate card**, **Same Dram comparison**, **flight results**, **Wrapped** — each an OG-imaged, non-indexed page (`robots: noindex` as today).
- Every shared object states its provenance ("Shared intentionally by its author") and carries the producer-attribution rule with it.
- Deep links open the native app when installed (`src/lib/native/*` seam, per AGENTS.md).

### 7.11 Bottle shares & samples (S3, high-utility)

The existing backlog item (2 oz samples, who owes whom) is a *social* feature and a good one: it's whiskey's actual social behaviour, it's utility rather than vanity, and it rewards generosity instead of consumption. Track sample swaps between friends, link a sample to the pour logged from it, and let the giver see the note the receiver wrote. **"Someone tasted the sample you sent and here's what they got"** is the warmest notification this app could send.

---

## 8. Privacy model

Alcohol consumption is sensitive personal data — in some jobs, families, jurisdictions and recovery contexts, seriously so. Strava's cautionary tale is that permissive defaults leaked home addresses and, in aggregate, military bases. Our defaults are the opposite.

**Principles:**

1. **Private by default, at every level.** Visibility is opt-in per pour, with a "default visibility for new pours" preference that ships as **Only me**. **No system action — migration, default change, or feature launch — ever raises the visibility of existing data.** The *owner* may: an explicit, confirmed "make my past pours friends-visible" bulk action is their right, and refusing to build it would be its own kind of paternalism. The ban is on defaults and dark patterns, not on the user's own choices.
2. **Money never travels.** Purchase price, collection value, spend, and cost-per-pour are excluded from every social projection — no exceptions, no toggle in v1. This is both a privacy and a safety property (a public high-value collection is a burglary target). Enforced structurally: social read paths use a projection type that doesn't carry these columns, mirroring how `getPublicPourShare()` is written today.
3. **Location is coarse and opt-in.** Venue tagging (if built) is a named place chosen by the user; no GPS, no automatic capture, no heatmaps, nothing at home-address resolution.
4. **Revocable and enumerable.** Every share link, every follower, every public object is listed in one place and revocable in one tap. Revocation is immediate and hard (row delete/tombstone), and OG images are regenerated/404'd.
5. **Deletion is real.** Deleting a pour removes it from feeds, links, and comparison aggregates. Account deletion is a hard delete (FEATURES.md §12) — social rows cascade, and content contributed to *aggregates* is either removed or was anonymised at write time.
6. **Export includes your social data** — your notes, your comments, your graph. Same free-forever rule.
7. **Age gate at signup covers social.** The existing gate is the gate; no separate re-check ceremony at first social action — social surfaces expose nothing age-worse than the journal itself.

**Anti-goals:** no public-by-default anything; no follower counts as status; no "who viewed your profile"; no shadow profiles for non-users; no selling or brand-sharing of individual-level social data (PLAN.md §6.3 aggregate-only rule extends here unchanged).

---

## 9. Data model additions

Sketch in the style of PLAN.md §4.3; final shapes live in `src/db/schema.ts` and migrations are generated, never hand-written (AGENTS.md).

```
-- S1
pour_shares += revoked_at                              -- close the shipped gap

-- S2
user_profiles(user_id PK, handle unique, display_name, avatar_url, bio,
              home_region, is_public, discoverable, created_at)
follows(id, follower_id, followee_id, state,          -- pending / accepted
        created_at, unique(follower_id, followee_id))
blocks(id, blocker_id, blocked_id, created_at)        -- checked on every social read
pours.visibility                                       -- NEW column: private (default) /
                                                       -- friends / followers / public
user_social_prefs(user_id PK, default_pour_visibility, show_flavor_tags,
                  allow_comments, notify_prefs jsonb)
reactions(id, subject_type, subject_id, user_id, kind, created_at,
          unique(subject_type, subject_id, user_id, kind))   -- subject: pour / comment / flight

-- S3
comments(id, subject_type, subject_id, user_id, body, parent_id?,
         created_at, edited_at, deleted_at)
reports(id, subject_type, subject_id, reporter_id, reason, state, created_at)
clubs(id, name, slug, owner_id, visibility, created_at)
club_members(club_id, user_id, role, joined_at)
club_shelf(club_id, user_bottle_id, added_by, added_at)      -- opt-in per bottle
blind_flights(id, club_id?, host_id, name, state, revealed_at)
blind_flight_slots(id, flight_id, label, bottle_id)          -- hidden until revealed_at
blind_flight_entries(id, slot_id, user_id, pour_id?, rating, flavor_tags, guess_bottle_id?)
bottle_shares(id, giver_id, receiver_id, bottle_id, amount_ml, state, pour_id?)  -- samples
user_palate_similarity(user_a, user_b, score, computed_at)   -- cached, scheduled
```

**Read-path rule:** social reads go through explicit projection functions (the `getPublicPourShare()` pattern) that select columns individually. No social endpoint ever returns a `user_bottles` row or a `pours` row wholesale — that's how price data leaks.

**Scale posture:** fan-out-on-read (query the graph at request time, cache per user) is correct until well past our first 100k users. No feed materialisation table in v1.

---

## 10. Monetization fit

**Social is free. All of it.** Same logic as free scanning (COMPETITORS.md §7): the graph *is* the growth engine, and a paywalled graph doesn't grow. Concretely:

- **Free forever:** profile, follow, feed, cheers, comments, sharing links, Same Dram vs. friends, clubs, and blind flights — **hosting included, at any table size.** A flight night is the single best acquisition moment the app has (every guest installs to participate); charging the host taxes the growth loop at its strongest point.
- **Pro (already $5.99/mo):** deeper *analysis* of social data, never access to it — full palate-match breakdowns across your whole graph, club analytics ("what this club is missing"), Wrapped in full, and the existing Pro list.
- **The honest line:** if a feature makes the network bigger, it's free; if it makes *your understanding* of the network deeper, it can be Pro.
- New affiliate surface: friends' recommendations are a natural buying moment. The PLAN.md §6.3 rule holds without softening — never pay-to-rank, disclosed, and downstream of an honest recommendation.

---

## 11. Moderation, safety & abuse

Small graph now, real obligations anyway — but tooling sized to the surface that exists, not the one we fear:

- **Block/mute** ships with the graph (S2), enforced on every read path (blocked users' content never appears, in either direction). This is structural and must be in the first read-path code, because retrofitting it is how leaks happen.
- **Report** ships with comments (S3) — the first surface where a stranger's words can land in front of you unchosen. Before that, everything visible was chosen (you followed them), and unfollow/block covers it. The `reports` table is cheap, so land it whenever convenient; the *queue UI* reuses the bottle-submission review-queue pattern and isn't needed before S3.
- **User-generated text** (bio, comments, notes) is untrusted: escaped on render, rate-limited on write, length-capped, no links in bios until there's a reason.
- **Handle squatting/impersonation:** reserve an obvious-brands list (major distilleries and brands) at launch; impersonation is a reportable offence. No 500-name curation project — expand the list when someone actually tries.
- **Recovery-aware exits**: a one-tap "make everything private" and a full social-off switch that leaves the private journal fully working. Someone stepping back from drinking should be able to keep their notes and vanish from the graph in one action, without deleting anything.
- Region-specific rules for user-generated alcohol promotion get a checklist review **before S4 public discovery** — that's the phase where content first reaches strangers.

---

## 12. Metrics — including the ones that catch us doing harm

**Health metrics:** % of users with ≥1 follow (target: 40% of actives within 90 days of launch); notes shared per active sharer; Same Dram views per week; club retention at 12 weeks vs. non-club (Strava's ~3.5× is the ambition); wishlist adds sourced from a friend's note (the discovery payoff, the number the user actually asked for). For S1 specifically: share-link views by signed-in users, comparisons rendered, and wishlist adds from the share page — these tell us whether the comparison thesis holds before we build the graph.

**Guardrail metrics — a smoke alarm, not a circuit breaker.** The enforcement mechanism for responsible-drinking is the §3.1 mechanics bans, applied in review before anything ships. Metrics are how we verify the bans worked:

- **Pours logged per active user per week**, cohort-adjusted, watched across every social release. A sustained rise triggers investigation, not an automatic freeze — because *logging is not drinking*: better capture (imports, scanning, the app simply getting good) raises logged pours while actual drinking is flat, and new-user cohorts log backlogs. The earlier draft made this metric an automatic ship-blocker; that version punishes the app for working. What survives: if investigation ties a genuine frequency rise to a specific social mechanic, that mechanic gets fixed or pulled — the conclusion "engagement is up" never excuses it.
- Ratio of *tried* (samples, bar pours, friends' bottles) to *owned* pours — should rise, not fall; breadth over volume is the whole thesis.
- Share of sessions with no pour logged (should rise — the app is becoming readable, not just loggable).
- Reports per 1,000 social actions; block rate; % of users who turn social off after enabling it.

---

## 13. Phasing

Slots into PLAN.md §5 after Phase 3 (personalization). Nothing here precedes a working private core loop — the journal must be good alone, or the network has nothing to carry.

The re-slicing rule (changed from the first draft): **every phase ships a loop a user can feel**, and the riskiest assumption gets tested by the cheapest phase. The first draft's S1 ("identity & sharing") shipped a graph with nothing to look at, while the marquee comparison — and the sparse-overlap risk it depends on — waited for S2. Reordered:

| Phase | Scope | Stories | Milestone |
|---|---|---|---|
| **S1 — Share control & the first comparison** | `revoked_at` + `/sharing` management page; viewer-side comparison on `/s/[code]`; wishlist CTA. No graph, no profiles, no visibility model. | US-1..3 | *A share link becomes a two-way palate comparison, and every link is controllable.* Implementable today — zero open decisions (§16). |
| **S2 — Friends & Same Dram** | Profiles + handles, follow/friends, per-pour visibility, blocks, "From your friends" Home module, Same Dram friends column, Cheers, notification policy, "make everything private." | US-4..11 | *You follow a friend, and the bottle page answers "what did they taste that I didn't?"* |
| **S3 — Conversation & groups** | Comments + reports, clubs + shared shelf, blind flights (can lead the phase — no club dependency), samples, taste twins in recommendations. | US-12..16 | *A tasting club can run a night on Whaikey, and a friend's palate improves your recs.* |
| **S4 — Community scale** | Community flavor consensus, crowdsourced availability, moderation tooling, public discovery, jurisdiction review. | US-17 | *Aggregates get good enough to be a reason to join.* |

**Sequencing rule, stated structurally rather than as a phase gate.** The first draft said "S1 ships fully before S2 opens." The real invariant is narrower: **nothing becomes visible to a second user until the visibility model and block checks are enforced on the read path that serves it.** Within S2 that means schema + projection functions land before any UI renders another person's data — ordinary dependency ordering. A phase-level freeze on top of that adds ceremony, not safety. (S1 needs no gate at all: it extends an existing bearer-token surface and shows the viewer only their own data.)

---

## 14. Decisions & open questions

The first draft left 14 questions open "for a human call before S1 code." Under the new phasing, S1 needs none of them — and most had an obviously right proposal, so they're now decisions. Overturn any of these by editing this table; until then, agents build to it.

### Decided

| # | Decision | Call |
|---|---|---|
| D1 | Graph shape | **Asymmetric follow** as the graph; mutual follow derived as "friends" gates intimate surfaces. Private accounts turn follows into requests. |
| D2 | Default visibility for new pours | **Only me**, with a user-settable default. The system never raises visibility of existing data; the owner explicitly can, including in bulk (§8, principle 1). |
| D3 | Public per-user counts | Never a sortable rank; coarse buckets/rates/sets fine (§3.3). |
| D4 | Reaction name | **"Cheers."** |
| D5 | Feed ordering | Chronological with a light own-bottles boost; no engagement ranking. Revisit only if sparsity, not attention, is the problem. |
| D6 | Community aggregates | Anonymous by default; attribution per-note opt-in (shipped stance). |
| D7 | Handle reservations | Reserve an obvious-brands list at launch; expand on demand. Not a 500-name project. |
| D8 | Graph import | **Amended (post-S2, owner call):** exact single-number phone lookup and profile QR codes are in — both double-opt-in (the target must set a number AND enable phone discovery; QR is the owner deliberately showing their own code), numbers stored only as a keyed hash, lookups durably rate-limited (claim/save attempts draw from the same budget — a save tests a number against the database too), "no match" indistinguishable from "not discoverable." Contact-book/bulk import remains banned — the liability was the address-book grab, not knowing one friend's number. |
| D9 | Friends' ratings vs. community rating | Separate labelled row, never mixed into the public average. |
| D10 | Feed placement | Home module, not a tab; data-driven promotion tripwire (§6.3). |
| D11 | Indexing | Shared pages stay `noindex` through S3; revisit at S4 with the jurisdiction review. |
| D12 | Edited shared notes | Link shows current state with an "edited" marker; deletion revokes. Never a stale public copy. |
| D13 | Venue/bar tagging | Not building it — the mechanic most implicated in the Untappd critique, and it buys us little. Reopen only with a concrete user need. |

### Still open (genuinely)

| # | Question | Current lean |
|---|---|---|
| Q1 | Whole-shelf sharing — when, and to whom? | S3, friends-only, opt-in per bottle, prices stripped. The most-requested collector feature and the most dangerous to defaults; wants a human look at the actual S2 privacy telemetry first. |
| Q2 | Jurisdiction rules for user-generated alcohol content in launch markets | Checklist review before S4 public discovery (§11). |

**Research still open:** whether Whiskey Social / DramIt's feeds actually retain users or are ghost towns (the honest failure mode for whiskey social — the category may simply be less social than beer); and whether club-level blind flights work over distance or need co-location. The third research question from the first draft — how much bottle overlap two users need before comparison is interesting — is no longer a desk question: **S1 measures it directly** (§12), which is the main reason S1 is scoped the way it is.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| **Sparse overlap** — friends haven't tasted the same bottles, so comparison has nothing to compare | **Tested in S1 for the cost of one page section**, before any graph is built. Beyond that: compare at the *descriptor* level, not just the bottle level (palate match works with zero shared bottles); seed with widely-owned bottles; make the discovery framing ("3 friends tasted this") the fallback when overlap is absent |
| Cold-start empty feed | S1 ships value with a graph of one (comparison on links you already share); the Home module only appears in S2 when there's a graph to fill it, and it's designed sparse-first |
| Social drags the product toward consumption incentives | The §3 mechanic bans enforced in review, verified by the §12 metrics |
| A privacy leak (prices, location, or a pour someone thought was private) | Private-by-default, structural projection types, no system-raised visibility, the §13 read-path invariant |
| Feeds are table stakes and we spend Phase 4 building a commodity | Only ship social that is downstream of the taxonomy/calibration moat; the comparison card, not the activity stream |
| Moderation load on a small team | Small graph first (friends and clubs, not public discovery), block-first enforcement, reports with comments, public discovery deferred to S4 |
| Category may just be less social than beer/running | Metrics gate: if S1's comparison numbers and S2's follow/discovery targets both miss, stop at S2 and keep social as a sharing feature rather than a network |

---

## 16. S1 build spec (agent-ready)

Everything below follows AGENTS.md conventions: `getDb()`/schema/`pnpm db:generate` for data, `requireUser()`/`getSessionUser()` for auth, zod on inputs, route tests against the in-memory DB, jsdom component tests with `afterEach(cleanup)`, visual baselines for changed screens per docs/DESIGN.md, and `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green before push. No prices in anything below — the projections already exclude them; keep it that way.

### 16.1 Schema

- `pourShares` gains `revokedAt: timestamp("revoked_at")` (nullable). Migration via `pnpm db:generate`.

### 16.2 Lib

- `src/lib/pour-sharing.ts`:
  - `getPublicPourShare()` treats `revokedAt IS NOT NULL` as not found, and adds `bottleId` to the `PublicPourShare` projection (a catalog id, not private data — needed by the viewer comparison and wishlist CTA below).
  - `createPourShare()` on a revoked share **updates the existing row with a fresh code and clears `revokedAt`** (`pour_shares.pour_id` is unique, so re-share is an update, not an insert). Reusing the old code would resurrect a link the user believes dead.
  - New `revokePourShare(db, userId, pourId)` — sets `revokedAt`; scoped to owner.
  - New `listPourShares(db, userId)` — active shares joined with bottle name + created date, for the management page.
- New `src/lib/flavor-compare.ts`: pure function `compareFlavorNotes(mine, theirs)` over two `flavorTags` records → `{ both, onlyMine, onlyTheirs }` of leaf ids, grouped by wedge for display, ordered by intensity. Uses `src/lib/flavor-wheel.ts` ids only; unit tests cover empty/disjoint/identical/unknown-id inputs. (Kept separate from `getFlavorCalibration()`, which is producer-vs-you across a whole bar; this is note-vs-note on one bottle. If implementation finds a clean shared core, extracting one is welcome but not required.)

### 16.3 API

- `DELETE /api/pours/[id]/share` — `requireUser()`; revokes own share (idempotent 200 with `{ revoked: true }`); 404 for missing/foreign pours (matching existing 404 convention). Extend the existing share route file.
- No list API needed — `/sharing` reads via `listPourShares()` in a server component.

### 16.4 Pages & components

- **`/sharing`** *(new page)*: "Shared links" — each row: bottle name, shared date, view link, revoke button (client component calling the DELETE route, optimistic removal). Empty state explains bearer links. Entry points: a link from `/history` near the share buttons, and from the share-confirmation UI in `PourShareButton`.
- **`/s/[code]`** *(extend)*: after the existing public card, render a **viewer-private block** via `getSessionUser()`:
  - Viewer has tasting notes on the same bottle → comparison block (`ShareComparison` component): "You both got…", "They got — you didn't", "You got — they didn't", chips colored by wedge family per DESIGN.md. Multiple viewer notes on the bottle: use the union of the viewer's tags (matches how calibration treats repeat pours).
  - Signed-in, no notes on the bottle → "Add to wishlist" CTA hitting the existing `POST /api/user-bottles` (relationship `wishlist`); if a relationship already exists, show its state instead.
  - Viewer is the sharer → no self-comparison; show "This is your link · manage shared links" pointing at `/sharing`.
  - Signed out → page unchanged.
  - The comparison renders only for the viewer; nothing about the viewer is written, and the OG image/card is unchanged (it must never depend on who's looking).

### 16.5 Tests & baselines

- Route tests: revoke → subsequent `getPublicPourShare` misses and `/s/[code]` 404s; foreign-user revoke → 404; re-share after revoke → new code, old code stays dead.
- Lib tests: `flavor-compare` cases above; `listPourShares` excludes revoked.
- Component tests (jsdom): `ShareComparison` renders the three groups and handles empty overlap ("no descriptors in common — that's a conversation").
- Visual baselines: `/sharing` and the signed-in `/s/[code]` comparison state, using `e2e/demo-seed.ts` fixed data + minted session cookies from `e2e/fixtures.ts` (both users and their notes on a shared bottle need deterministic seeds). Regenerate, look at the PNGs, commit.

### 16.6 Acceptance (maps to §5)

- US-1: two seeded users with notes on the same bottle → the signed-in viewer of the other's share link sees the three comparison groups; the sharer's page output contains nothing about any viewer.
- US-2: every active link is listed on `/sharing`; revoking makes the public URL 404 on the next request; the pour and its note are untouched.
- US-3: a signed-in viewer with no relationship to the bottle can wishlist it from the share page in one tap.

---

**Sources for the external research in §2 and §3:** [Strava gamification case study](https://trophy.so/blog/strava-gamification-case-study) · [Strava marketing/community analysis](https://nogood.io/blog/strava-marketing-strategy/) · [Kudos and social influence on Strava (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S0378873322000909) · [A Longitudinal Analysis of Gamification in Untappd (arXiv 2601.04841)](https://arxiv.org/html/2601.04841v1) · [Strava privacy defaults](https://support.strava.com/en-us/articles/15401763-your-privacy-defaults-when-you-create-a-strava-account) · [Best whiskey tracking apps 2026](https://whiskeysocial.app/blog/best-whiskey-tracking-apps-in-2026)

# Whaikey — Social Plan

Companion to [PLAN.md](../PLAN.md), [FEATURES.md](./FEATURES.md) and [COMPETITORS.md](./COMPETITORS.md). This is the design doc for turning Whaikey from a private tasting journal into something friends use *together* — without becoming a drinking leaderboard.

**The ask, in the user's words:** *"share with my friends what I tried, what I tasted and how it compared to producer notes. Strava does this well. It would help me discover whiskey better and connect with some friends better."*

**TL;DR:** Strava's magic isn't the feed — it's that everyone runs the *same segment*, so comparison is meaningful and identity is earned. In whiskey the shared course is **the bottle**, and the thing being compared is **your palate**, not your consumption. That single substitution gives us a social product that is genuinely differentiated *and* structurally compatible with our responsible-drinking guardrails, because it rewards discernment and breadth rather than volume and frequency. Everything below follows from it.

---

## 1. Why social, why now

Three arguments, in order of strength:

1. **Discovery gets better with people in it.** Our recommendation engine is content-based (palate vector × bottle embeddings). Collaborative signal — "people whose palate matches yours rated this 4.5" — is the standard cold-start fix and we cannot generate it from one user. A friend graph is the highest-quality version of that signal, because trust is already established.
2. **The comparison we already built is only half-finished.** `getFlavorCalibration()` (shipped, #50) lines your flavor tags up against the producer's and tells you *"you call clove cinnamon."* That is a fascinating thing to see alone and a *much* better thing to see next to a friend who tasted the same bottle. The third column — friends — is the missing one.
3. **Retention on non-drinking days.** Same argument as Whiskey School (FEATURES.md §10): the app needs reasons to open that aren't "pour a drink." Reading what your friends thought is the biggest one, and it carries zero consumption incentive.

The counter-argument, stated honestly: **social is not our wedge.** Distiller, Whiskybase, DramIt and Whiskey Social all have feeds already (COMPETITORS.md §2). Shipping "a feed" buys nothing. We ship social *only* in the form that is downstream of our actual moat — the flavor taxonomy, the calibration engine, and the palate model. A generic activity stream is explicitly out of scope; see §5.3 for what replaces it.

---

## 2. The thesis: what Strava actually gets right

Strava is often mis-copied as "a feed with likes." The mechanics that carry it are narrower and more specific:

| Strava mechanic | What it actually does | Whiskey analog | Verdict |
|---|---|---|---|
| **Segments** — a shared stretch of road everyone rides | Makes efforts *comparable*. Without a shared course a feed is just noise. | **The bottle.** Two people who both drank Lagavulin 16 have run the same segment. | **Adopt — this is the whole design.** |
| **Kudos** | Cheap, positive-only, one-tap acknowledgement. No downvote, so the feed stays warm. | One-tap "Cheers" on a note or a pour. | Adopt (positive-only, no dislike). |
| **Comments** | Where the actual conversation happens; low volume, high value. | Same, threaded under a note. | Adopt. |
| **Clubs** | Small-group belonging. Club members are ~3.5× more likely to still be active at 12 months. | Tasting clubs / whisky societies / a group chat that owns a shared shelf. | Adopt — and it's where blind flights live (§5.9). |
| **Following (asymmetric)** | Low-friction graph growth; you don't need permission to admire someone. | Follow a friend or a taster whose palate you rate. | Adopt, with an approval option for private accounts. |
| **Activity as content** | The workout you did anyway becomes the post. Zero extra authoring cost. | The pour you logged anyway becomes the post. | Adopt — sharing must be a visibility flag on an existing pour, never a separate "compose" flow. |
| **KOM/QOM leaderboards** | Ranks people by performance on the segment. | Ranking people by… drinking the most of a bottle. | **Reject.** No ranking of people by consumption, ever. |
| **Local Legend** (most *frequent* completions) | Explicitly rewards repetition. | Rewards drinking the same bottle most often. | **Reject outright.** This is the single most dangerous mechanic to port. |
| **Streaks / weekly volume goals** | Habit formation via consecutive-day pressure. | Consecutive drinking days. | **Reject outright.** |
| **Heatmaps / route maps** | Location as content. | Bar and home location as content. | Reject as a default; venue tagging is opt-in and coarse (§6). |

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

### 3.1 Banned mechanics (hard rules, no exceptions, enforced in review)

1. No metric that counts pours, volume, ABV, or consecutive days is ever **displayed to another user**, ranked, or used in a badge, level, or notification.
2. No streaks. No "you haven't logged in 3 days" reactivation nudges tied to drinking.
3. No leaderboard whose sort key is a consumption quantity. (Rating counts and note counts are also proxies for consumption — see §3.3.)
4. No notification that suggests pouring, or that implies progress toward a reward if the user drinks.
5. No time-of-day, venue-frequency, or strength-based achievements.
6. No public "who's drinking right now" presence.

### 3.2 Encouraged mechanics (the substitutes)

| Instead of rewarding… | We reward… | Data it uses |
|---|---|---|
| Volume | **Breadth** — regions, styles, cask types, distilleries *encountered* (a 15 ml sample at a bar counts the same as a bottle) | `tried` relationships |
| Frequency | **Precision** — descriptor vocabulary size, agreement with published notes, blind-tasting calibration | `tastingNotes.flavorTags`, `getFlavorCalibration()` |
| Being first/most | **Being useful** — notes others found helpful, a substitute mapping that made a friend go "oh, that's what I taste" | Cheers/comments received |
| Drinking a rare bottle | **Sharing a rare bottle** — sample swaps, pours poured for others, hosting a flight | Bottle-share tracker, flight hosting |

Note that every one of these is satisfiable by someone drinking *less* whiskey more attentively. That's the test: **if a mechanic can't be won by a moderate drinker, it doesn't ship.**

### 3.3 The subtle one: note count is a consumption proxy

"Most notes written" looks like a discernment metric and is really a drinking metric. Rules: any aggregate we display publicly is either (a) a **rate or ratio** (agreement %, distinct descriptors per note), (b) a **set** (regions covered — bounded, and completable), or (c) **explicitly bucketed and coarse** ("100+ notes" as a profile trust signal, never a rank). Absolute counts never sort a list of people.

---

## 4. What already ships (the foundation)

We are not starting from zero. Shipped today:

| Piece | Where | What it gives social |
|---|---|---|
| **Public pour links** | `pourShares` table, `/s/[code]`, `POST /api/pours/[id]/share`, `PourShareButton` on the history timeline | An opt-in, bearer-token public projection of one pour + note, with an OG image. Already carefully scoped: no prices, no inventory, no other pours. |
| **Producer-note calibration** | `getFlavorCalibration()` in `src/lib/bar.ts` | The shared/blind/signature buckets and the `substitutes` mapping — the "how it compared to producer notes" half of the ask, already computed. |
| **Attributed producer claims** | `bottles.producerFlavorTags` + `producerFlavorSourceUrl` + `producerFlavorSourceLabel`, gated by `hasPublishedProducerFlavorNotes()` | A producer claim is only displayable with a source. This rule extends unchanged into every social surface. |
| **Shared flavor taxonomy** | `src/lib/flavor-wheel.ts` (8 wedges, ~55 leaves) | The reason cross-user comparison is even possible: everyone's notes are in the same coordinate space. Free-text notes could never be compared this way. |
| **Palate model** | `src/lib/palate.ts`, palate wheel | The input to taste-match between people (§5.7). |

**Gaps in the shipped share flow** that this plan closes: a share link cannot be revoked (only deleting the pour revokes it, via cascade); there is no per-pour visibility concept (a pour is private or bearer-public, nothing between); the share page has no identity behind it (a name string, not a profile); and nothing links two people who shared notes on the same bottle.

---

## 5. The feature set

### 5.1 Identity — profile & palate card (Phase S1)

- `@handle` (unique, immutable-ish, claimable at first social action — not at signup, which stays a 90-second path), display name, avatar, one-line bio, optional home region.
- **The profile *is* the palate card**, not a wall of pours: your palate wheel, your top signature descriptors, regions/styles covered, and 3 recent public notes. This is the shareable artifact (FEATURES.md §9.3) and the thing that makes a follow decision easy.
- Public-profile toggle; a private profile is discoverable only by exact handle.
- Profiles never show: spend, collection value, purchase prices, bottle counts by quantity, or anything from §3.1.

### 5.2 The graph — follow, friends, and why we're picking follow (Phase S1)

**Decision: asymmetric follow, with an optional approval gate.** Reasons: it's the lower-friction growth mechanic (Strava, Instagram), it lets a beginner follow an expert taster without a reciprocal relationship, and mutual-follow can be *derived* ("friends" = you follow each other) to gate the more intimate surfaces. Private accounts flip follows into requests.

- Visibility tiers used everywhere: **Only me** (default) → **Friends** (mutual follows) → **Followers** → **Anyone with the link** → **Public**.
- Finding people: exact-handle search, contact/social-graph invite links, "friends of friends who drink what you drink," and same-bottle discovery (§5.6). No contact-book upload without explicit per-use consent, and never stored.
- Blocking and muting are first-class from day one (§9), not a Phase-2 bolt-on.

### 5.3 The feed — but as a *comparison* stream (Phase S2)

The feed is where most social products go generic. Ours is constrained by one rule: **a feed item is only interesting if it lets you compare.** So the card is not "Nick drank a thing":

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
- **Chronological by default** with a light relevance filter (bottles you own/wishlist/have tried rank up). No engagement-optimised ranking — we are not fighting for time-on-app, and an algorithmic drinking feed is a bad object to have built.
- Empty and low-volume states matter more than the full state: with 4 friends this feed has ~2 items a week, and it must feel calm rather than dead. Design it for the sparse case first (DESIGN.md rules apply).

### 5.4 Same Dram — the signature surface (Phase S2, the marquee)

The bottle page gains a comparison view: **you vs. the producer vs. your friends**, all in the same flavor coordinate space.

- Three-column (or overlaid-wheel) view of the same ~55 leaf descriptors: what the label claims (attributed, per `hasPublishedProducerFlavorNotes()`), what you wrote, what each friend wrote.
- Reuses the shipped bucket vocabulary: **shared** (label named it, you did too), **blind** (label named it, you missed it), **signature** (only you name it) — now with a fourth, social bucket: **contested** (a descriptor your friends split on).
- The payoff line is the same one calibration already produces, pointed at a person instead of a label: *"Where Sarah writes clove, you write cinnamon."* That is the sentence that makes someone screenshot the app.
- **Never framed as right/wrong.** The existing rule stands verbatim: a published tasting note is one opinion written once by someone selling the bottle. Friends' notes are opinions too. This is calibration against reference points, never accuracy against an answer key.
- Feeds directly back into discovery: a friend whose blind spots mirror yours is a strong recommendation source; one whose signature descriptors you consistently also find is a **taste twin** (§5.7).

### 5.5 Reactions & comments (Phase S2)

- One-tap positive reaction. **Naming decision pending** (§12 Q4) — leading candidate **"Cheers"**; alternatives "Slàinte", "Neat", "Dram it". Positive-only; there is no dislike.
- Comments threaded on a note, plain text, mentions with `@handle`, edit window, soft delete.
- Reaction/comment counts are shown on the object, never aggregated into a person-level score or rank.
- Notifications for these are **batched and quiet** by default (§5.12).

### 5.6 The bottle as a social object (Phase S2)

Every bottle page gets a community section that is the segment leaderboard's honest cousin:

- Community rating distribution (already planned, FEATURES.md §2.4) plus **friends' ratings surfaced first**.
- **Community flavor consensus** vs. the producer's claim — an aggregate-level version of calibration that is genuinely novel: *"The label says honey. 71% of drinkers say caramel."* Nobody else can compute this, because nobody else has a shared taxonomy plus attributed producer claims.
- "Others who tasted this" is capped, opt-in, and ordered by palate match — never by who drinks it most.
- Contribution to community aggregates is opt-in and anonymised by default (FEATURES.md §9.1 stands).

### 5.7 Taste twins & palate match (Phase S3)

- Cosine similarity between palate vectors → a **match %** shown on profiles and friends' notes ("87% palate match").
- Uses: friend suggestions, weighting friends' ratings in recommendations (collaborative signal, finally), and explanation text — *"recommended partly because your two closest palate matches both rated it 4.5+."*
- Guardrail: match % is a **relationship** property, never a rank. There is no "top tasters" list.
- Computed on a schedule and cached (`user_palate_similarity`), not per-request.

### 5.8 Clubs (Phase S3)

Small groups are the retention mechanic worth copying wholesale.

- Create a club (name, avatar, private/invite/public), invite by link, roles owner/member.
- Club surfaces: a club feed (same comparison card), a **shared shelf** (bottles members own, opt-in per bottle), club-only notes, and a club palate wheel — *"this club leans peaty, and nobody here has anything floral."*
- Real-world fit: whisky societies, a bottle-share group, four friends in a group chat. Aim at the group of 4, not the community of 4,000.

### 5.9 Blind flights — the group killer feature (Phase S3)

Already specified in PLAN.md §2.8 and FEATURES.md §4.5; social makes it real. Host picks bottles, app assigns blind letters, each guest logs ratings + wheel notes from their own phone, host triggers the reveal, and everyone sees:

- Aggregate scores per bottle, who guessed which bottle was which, and a group-level Same Dram view (§5.4) — including how the whole table compared to the producer's notes.
- A shareable results card (the growth loop) and a club-history record.
- This is the one social feature that is *better in person*, which is exactly the kind of social feature an alcohol app should be optimising for: it moves engagement toward shared, occasion-based, moderate drinking and away from solo daily logging.

### 5.10 Sharing outward (Phase S1 — extends what's shipped)

- Keep the bearer-link model (`/s/[code]`) and **add revocation** plus a "my shared links" management page. Bearer links are the safest primitive we have; they should be fully controllable.
- Extend beyond a single pour: shareable **palate card**, **Same Dram comparison**, **flight results**, **Wrapped** — each an OG-imaged, non-indexed page (`robots: noindex` as today).
- Every shared object states its provenance ("Shared intentionally by its author") and carries the producer-attribution rule with it.
- Deep links open the native app when installed (`src/lib/native/*` seam, per AGENTS.md).

### 5.11 Bottle shares & samples (Phase S3, high-utility)

The existing backlog item (2 oz samples, who owes whom) is a *social* feature and a good one: it's whiskey's actual social behaviour, it's utility rather than vanity, and it rewards generosity instead of consumption. Track sample swaps between friends, link a sample to the pour logged from it, and let the giver see the note the receiver wrote. **"Someone tasted the sample you sent and here's what they got"** is the warmest notification this app could send.

### 5.12 Notifications — the restraint spec (Phase S2)

Given §3.1, the notification policy needs writing down rather than assuming:

- **Allowed:** someone followed you; someone cheered/commented on your note; a friend tasted a bottle you've also tasted (batched, max 1/day); flight/club events you opted into; a sample recipient logged their note.
- **Banned:** anything mentioning pouring, any "you haven't logged since…", any progress-toward-reward nudge, any "your friends are drinking right now."
- Defaults: follows and direct replies on; everything else off or daily-batched. Quiet hours respected. Full per-category control.

---

## 6. Privacy model

Alcohol consumption is sensitive personal data — in some jobs, families, jurisdictions and recovery contexts, seriously so. Strava's cautionary tale is that permissive defaults leaked home addresses and, in aggregate, military bases. Our defaults are the opposite.

**Principles:**

1. **Private by default, at every level.** Existing pours stay private forever; visibility is opt-in per pour, with an optional "default visibility for new pours" preference that ships defaulted to **Only me**. No migration ever makes existing data more visible.
2. **Money never travels.** Purchase price, collection value, spend, and cost-per-pour are excluded from every social projection — no exceptions, no toggle in v1. This is both a privacy and a safety property (a public high-value collection is a burglary target). Enforced structurally: social read paths use a projection type that doesn't carry these columns, mirroring how `getPublicPourShare()` is written today.
3. **Location is coarse and opt-in.** Venue tagging (if built) is a named place chosen by the user; no GPS, no automatic capture, no heatmaps, nothing at home-address resolution.
4. **Revocable and enumerable.** Every share link, every follower, every public object is listed in one place and revocable in one tap. Revocation is immediate and hard (row delete/tombstone), and OG images are regenerated/404'd.
5. **Deletion is real.** Deleting a pour removes it from feeds, links, and comparison aggregates. Account deletion is a hard delete (FEATURES.md §12) — social rows cascade, and content contributed to *aggregates* is either removed or was anonymised at write time.
6. **Export includes your social data** — your notes, your comments, your graph. Same free-forever rule.
7. **Age gate before any social surface** (existing signup gate, re-checked at first social action).

**Anti-goals:** no public-by-default anything; no follower counts as status; no "who viewed your profile"; no shadow profiles for non-users; no selling or brand-sharing of individual-level social data (PLAN.md §6.3 aggregate-only rule extends here unchanged).

---

## 7. Data model additions

Sketch in the style of PLAN.md §4.3; final shapes live in `src/db/schema.ts` and migrations are generated, never hand-written (AGENTS.md).

```
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
comments(id, subject_type, subject_id, user_id, body, parent_id?,
         created_at, edited_at, deleted_at)

clubs(id, name, slug, owner_id, visibility, created_at)
club_members(club_id, user_id, role, joined_at)
club_shelf(club_id, user_bottle_id, added_by, added_at)      -- opt-in per bottle

blind_flights(id, club_id?, host_id, name, state, revealed_at)
blind_flight_slots(id, flight_id, label, bottle_id)          -- hidden until revealed_at
blind_flight_entries(id, slot_id, user_id, pour_id?, rating, flavor_tags, guess_bottle_id?)

bottle_shares(id, giver_id, receiver_id, bottle_id, amount_ml, state, pour_id?)  -- samples

user_palate_similarity(user_a, user_b, score, computed_at)   -- cached, scheduled

pour_shares += revoked_at                                    -- close the shipped gap
reports(id, subject_type, subject_id, reporter_id, reason, state, created_at)
```

**Read-path rule:** social reads go through explicit projection functions (the `getPublicPourShare()` pattern) that select columns individually. No social endpoint ever returns a `user_bottles` row or a `pours` row wholesale — that's how price data leaks.

**Scale posture:** fan-out-on-read (query the graph at request time, cache per user) is correct until well past our first 100k users. No feed materialisation table in v1.

---

## 8. Monetization fit

**Social is free. All of it.** Same logic as free scanning (COMPETITORS.md §7): the graph *is* the growth engine, and a paywalled graph doesn't grow. Concretely:

- **Free forever:** profile, follow, feed, cheers, comments, sharing links, Same Dram vs. friends, clubs, joining blind flights.
- **Pro (already $5.99/mo):** deeper *analysis* of social data, never access to it — full palate-match breakdowns across your whole graph, club analytics ("what this club is missing"), hosting flights beyond N participants, Wrapped in full, and the existing Pro list.
- **The honest line:** if a feature makes the network bigger, it's free; if it makes *your understanding* of the network deeper, it can be Pro.
- New affiliate surface: friends' recommendations are a natural buying moment. The §6.3 rule holds without softening — never pay-to-rank, disclosed, and downstream of an honest recommendation.

---

## 9. Moderation, safety & abuse

Small graph now, real obligations anyway:

- **Block/mute** at the account level, enforced on every read path (blocked users' content never appears, in either direction).
- **Report** on notes, comments, profiles → a review queue reusing the pattern of the existing bottle-submission review queue.
- **User-generated text** (bio, comments, notes) is untrusted: escaped on render, rate-limited on write, length-capped, no links in bios until there's a reason.
- **Handle squatting/impersonation**: reserved handles for distilleries and known brands; impersonation is a reportable offence.
- **Age and jurisdiction**: no social surfaces below the gate; consider region-based restrictions where alcohol social promotion is regulated.
- **Recovery-aware exits**: a one-tap "make everything private" and a full social-off switch that leaves the private journal fully working. Someone stepping back from drinking should be able to keep their notes and vanish from the graph in one action, without deleting anything.

---

## 10. Metrics — including the ones that catch us doing harm

**Health metrics:** % of users with ≥1 follow (target: 40% of actives within 90 days of launch); notes shared per active sharer; Same Dram views per week; club retention at 12 weeks vs. non-club (Strava's ~3.5× is the ambition); wishlist adds sourced from a friend's note (the discovery payoff, the number the user actually asked for).

**Guardrail metrics (reviewed every release; regressions block shipping more social):**

- **Pours logged per active user per week — must not rise materially after each social launch.** If a social feature increases drinking frequency, that feature is a defect regardless of its engagement numbers. This is the single most important number in this document.
- Ratio of *tried* (samples, bar pours, friends' bottles) to *owned* pours — should rise, not fall; breadth over volume is the whole thesis.
- Share of sessions with no pour logged (should rise — the app is becoming readable, not just loggable).
- Reports per 1,000 social actions; block rate; % of users who turn social off after enabling it.

---

## 11. Phasing

Slots into PLAN.md §5 after Phase 3 (personalization). Nothing here precedes a working private core loop — the journal must be good alone, or the network has nothing to carry.

| Phase | Scope | Milestone |
|---|---|---|
| **S1 — Identity & sharing** | Profiles + handles, palate card, follow graph, visibility model on pours, share revocation + management, blocks | *You can follow a friend and choose what they see. Nothing is public by accident.* |
| **S2 — Comparison** | Comparison feed, Same Dram (you vs. producer vs. friends), cheers, comments, bottle community section, notification policy | *The user's ask is delivered: share what you tried, what you tasted, and how it compared.* |
| **S3 — Groups & depth** | Clubs, blind flights end-to-end, taste twins/palate match in recommendations, bottle shares & samples | *A tasting club can run a night on Whaikey and a friend's palate improves your recs.* |
| **S4 — Community scale** | Community flavor consensus at scale, crowdsourced availability, moderation tooling, public discovery | *Aggregates get good enough to be a reason to join.* |

Sequencing rule: **S1 ships fully before S2 opens**, because every S2 surface depends on the visibility model being correct. Getting privacy wrong once is unrecoverable in this category.

---

## 12. Open questions & decisions

Proposals given; these want a human call before S1 code.

| # | Question | Proposal |
|---|---|---|
| Q1 | Asymmetric follow, mutual friends, or both? | **Both, layered:** asymmetric follow as the graph, mutual follow derived as "friends" to gate intimate surfaces (shelf, precise comparisons). |
| Q2 | Default visibility for newly logged pours? | **Only me**, with a persistent preference the user can change. Nothing retroactive, ever. |
| Q3 | Do we ever show ratings *counts* per user publicly? | Bucketed only ("100+ notes") as a trust signal, never a sortable rank (§3.3). |
| Q4 | What do we call the reaction? | **"Cheers"** (clear, warm, non-alcohol-specific verb). Alternatives: Slàinte, Neat, Dram it. Low stakes, decide once, hard to change later. |
| Q5 | Is the feed chronological or ranked? | Chronological with a light own-bottles boost; no engagement optimisation (§5.3). Revisit only if sparsity, not attention, is the problem. |
| Q6 | Anonymous community aggregates vs. attributed community notes? | Aggregates anonymous by default (shipped stance); attribution only for users who opt in per note. |
| Q7 | Handle namespace — reserve brand/distillery handles? | Yes, reserve the top ~500 distilleries at launch; cheap insurance against impersonation. |
| Q8 | Import the graph from anywhere (contacts, X, Instagram)? | Invite links only in S1. Contact matching is a privacy liability we don't need to grow 4-person clubs. |
| Q9 | Do friends' ratings affect the *headline* community rating? | No — friends are a separate, labelled row. Mixing them corrupts a public statistic. |
| Q10 | Should venue/bar tagging exist at all? | Deferred past S4. It's the mechanic most implicated in the Untappd critique and buys us little. |
| Q11 | Do we let people share a *bar* (whole shelf), not just a pour? | S3, friends-only, opt-in per bottle, prices stripped. Sharing a shelf is the most-requested collector feature and the most dangerous to defaults. |
| Q12 | Public web presence for shared notes — indexed or not? | Stay **noindex** (current behaviour) through S3. SEO on user drinking data is a trade we shouldn't make early. |
| Q13 | What happens to a shared note when the pour is edited? | Link shows current state with an "edited" marker; deletion revokes. Never silently keep a stale public copy. |
| Q14 | Age/jurisdiction rules for social specifically? | Gate at first social action, and check whether any launch market restricts user-generated alcohol promotion before S4 public discovery. |

**Research still open:** whether Whiskey Social / DramIt's feeds actually retain users or are ghost towns (the honest failure mode for whiskey social — the category may simply be less social than beer); how many bottles two random users must share before Same Dram is interesting (it needs *overlap*, and collector shelves overlap less than running routes do — this is the biggest product risk in the doc, see §13); and whether club-level blind flights work over distance or need co-location.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| **Sparse overlap** — friends haven't tasted the same bottles, so comparison has nothing to compare | Compare at the *descriptor* level, not just the bottle level (palate match works with zero shared bottles); seed with widely-owned bottles; make the discovery framing ("3 friends tasted this") the fallback when overlap is absent |
| Cold-start empty feed | S1 ships value with a graph of one (your own palate card, share links); feed only opens in S2 when there's something to fill it |
| Social drags the product toward consumption incentives | The §3 hard rules plus the §10 guardrail metric with an explicit block-shipping consequence |
| A privacy leak (prices, location, or a pour someone thought was private) | Private-by-default, structural projection types, no retroactive visibility changes, S1-before-S2 sequencing |
| Feeds are table stakes and we spend Phase 4 building a commodity | Only ship social that is downstream of the taxonomy/calibration moat; the comparison card, not the activity stream |
| Moderation load on a small team | Small graph first (clubs and friends, not public discovery), report queue from day one, public discovery deferred to S4 |
| Category may just be less social than beer/running | Metrics gate: if S1+S2 don't hit the follow/discovery targets, stop at S2 and keep social as a sharing feature rather than a network |

---

**Sources for the external research in §2 and §3:** [Strava gamification case study](https://trophy.so/blog/strava-gamification-case-study) · [Strava marketing/community analysis](https://nogood.io/blog/strava-marketing-strategy/) · [Kudos and social influence on Strava (ScienceDirect)](https://www.sciencedirect.com/science/article/pii/S0378873322000909) · [A Longitudinal Analysis of Gamification in Untappd (arXiv 2601.04841)](https://arxiv.org/html/2601.04841v1) · [Strava privacy defaults](https://support.strava.com/en-us/articles/15401763-your-privacy-defaults-when-you-create-a-strava-account) · [Best whiskey tracking apps 2026](https://whiskeysocial.app/blog/best-whiskey-tracking-apps-in-2026)

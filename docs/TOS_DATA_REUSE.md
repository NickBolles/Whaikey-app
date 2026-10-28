# Caskfolk — restricting reuse of our data (DRAFT, 2026-10-28)

**Status: draft for owner + lawyer review. Not legal advice. Do not merge without both.**
Owner question: *"Does Caskfolk need some clauses in TOS to restrict the same data reuse?"* — i.e. stop
others scraping/reusing our catalog, flavour profiles, tasting notes and photos, the way we can't reuse
other sites' photos.

**Short answer: yes.** Today's `/terms` has no acceptable-use, anti-scraping, database or takedown
clause, there is no `robots.txt` (prod `/robots.txt` → 404), and `GET /api/bottles/search` is public,
unauthenticated and un-rate-limited, returning name + category + flavour profile per hit. Contract terms
help (they make scraping a breach and support a claim), but in the US the catalog's *facts* get little
copyright protection (*Feist*), so the practical protection is **terms + robots.txt + rate limiting**
together. Whatever we claim must leave the open-licensed data underneath free.

---

## 1. What we found (repo state at `origin/main` 30d229c)

| Thing | State |
|---|---|
| `/terms` | Ownership + display licence for user content, moderation, catalog contributions, AI, disclaimers. **No** acceptable use / scraping / DB rights / takedown. |
| `/privacy` | Detailed per-table; lists UPCitemdb + Open Food Facts lookups. Nothing about crawlers. |
| robots.txt | None (404 in prod). |
| Rate limiting | Only AI features (`src/lib/ai/rate-limit.ts`, 20/h, 100/day per user, DB-backed) and per-user caps on submissions/barcode claims. `src/proxy.ts` only forwards the path. Public catalog search has **no limit**. |
| Age gate | Pages are cookie-gated (crawlers mostly see the gate), but `/api/*` and `/s/*` are ungated — the API is the real bulk-copy surface. |
| Credits page | None. |

## 2. Upstream licences — what LIMITS what we can restrict

| Source (docs/DATA_SOURCES.md) | Licence | Obligation on us | Can we forbid reuse? |
|---|---|---|---|
| TTB COLA registry | US gov public record | none (label artwork is brands'; we don't show it) | Not the records themselves; only our compilation |
| Iowa Liquor Products | **CC BY 4.0** | attribution + indicate changes | No — anyone can take it from Iowa. CC BY 4.0 §2(a)(5)(B) also forbids imposing "effective technological measures" on *the licensed material* that restrict recipients' rights → we must not claim Iowa data itself is ours; the carve-out sentence + /sources does this. **Lawyer Q1.** |
| BC Liquor price list | **OGL – British Columbia** | prescribed attribution statement | No (for the BC data) |
| WHISKY:EDITION (retired; rows remain) | **CC BY 4.0** | attribution | No (for that data) |
| Oregon OLCC / Utah DABS | state publications, terms unverified | likely none; confirm | Probably not the facts |
| Systembolaget via C4illin mirror | **unverified** | confirm repo licence | — **Lawyer/owner Q** |
| Vinmonopolet API | API terms | follow API terms (names only) | — |
| Open Food Facts | **ODbL 1.0** | Today: transient lookup in an isolated `upc_lookup_cache`, never merged into `bottles`. ODbL share-alike bites only if we *publicly use a derivative database*; produced works need a notice (added on /sources). If OFF data is ever merged into the catalog, **that portion must be offered under ODbL** and the anti-scraping clause can't cover it. **Lawyer Q2.** |
| UPCitemdb | commercial API ToS | no bulk seeding/redistribution | n/a (we don't redistribute) |
| Wikidata | CC0 | none (credit is courtesy) | No, but nothing to restrict |
| Wikimedia Commons logos (PR #134, unmerged) | per-file PD / CC0 / CC BY / CC BY-SA | per-image credit next to the image (PR #134 already only shows BY/BY-SA marks on the bottle page with credit); **BY-SA** files must stay BY-SA → we can't restrict reuse of those images | No, for those files |
| Producer site icons (PR #134) | not licensed; nominative use | identify-only, unaltered | We don't own them — not ours to license either |
| Editorial sites (Breaking Bourbon, Whisky Advocate) | link-only | linked, never copied | n/a |
| **User content** (notes, ratings, photos) | owned by users | we need a licence FROM them | We can forbid *third parties* scraping it (we're the host), but can't claim to own it |

**Therefore:** we can restrict (a) *how people access* the service (contract: no scraping, no bulk
download, no API use outside our apps, no rate-limit circumvention), (b) reuse of **our own
compilation and our own work** — the matching/dedupe, grouping, flavour profiles (community roll-ups
and model estimates), barcode mappings, editing — and (c) reuse of user content hosted with us, as the
licensee/host. We **cannot** restrict anyone taking the open data from its source, and we must keep
attributions (CC BY, OGL-BC, ODbL notice, Commons per-file credits).

## 3. What the draft PR changes

1. **`/terms`** — new sections (marked `DRAFT` in comments):
   - *Using the catalog — and what not to do with it*: no scraping/crawling except search engines per
     robots.txt; no bulk download or API use outside the apps; no competing DB/dataset or **AI/ML
     training, fine-tuning or evaluation** on Caskfolk content; no circumventing rate limits, access
     controls, the age gate or security; no harvesting users. Own-data export explicitly unaffected;
     "ask us" route for datasets/research.
   - *Whose the catalog is*: compilation/database rights claim (whatever the law gives) excluding user
     content; open-data carve-out → `/sources`; "nothing here restricts a right an open licence gives you".
   - *If something here is yours*: DMCA-style notice-and-takedown (elements of a notice, takedown,
     counter-notice-ish put-back, repeat-infringer termination). Routed to `/support`.
   - *What you post* (expanded): formal non-exclusive, worldwide, royalty-free licence to host/copy/
     resize/display/transmit **only to run Caskfolk and only to the chosen audience**; no selling,
     sublicensing to others, or AI training; ends on deletion (except report snapshot + backups).
     Catalog facts you contribute stay (unattributed) after you leave. **Bottle photos submitted for a
     catalog page** may be shown to everyone with credit until taken down (feature not built yet — the
     clause is worded conditionally).
2. **`/privacy`** — one paragraph: robots.txt keeps crawlers off share links/profiles and AI trainers
   off everything; it's a request, not a lock; Terms forbid scraping.
3. **`/robots.txt`** (`src/app/robots.ts`, list in `src/lib/crawlers.ts`): AI-training crawlers
   (GPTBot, ClaudeBot, anthropic-ai, CCBot, Google-Extended, Applebot-Extended, meta-externalagent,
   FacebookBot, Bytespider, Amazonbot, cohere-*, Diffbot, Timpibot, ImagesiftBot, omgili, PetalBot)
   → `Disallow: /`. Everyone else: allow `/`, disallow `/api/ /admin/ /s/ /u/ /o/ /f/`.
4. **`/sources`** credits page (ungated like the policies): every catalog source, its licence, and the
   required notices (Iowa CC BY, OGL-BC statement, ODbL notice for OFF, WHISKY:EDITION CC BY), plus
   "what is ours / what is not", flavour-profile provenance, images/logos credit policy, rights-holder
   contact.
5. Tests: `robots.test.ts`, `sources/sources.test.tsx`, age-gate ungated list. Local run: 34/34 pass,
   `tsc` and eslint clean.

**Not in the PR (owner action, free):** rate limiting via **Vercel WAF** — Hobby includes **1 rate-limit
rule** (within 3 custom rules), fixed window 10 s–10 min, keyed on IP or JA4, 1M allowed requests/month
included. Suggested rule: path starts with `/api/bottles` (search + bottle JSON) → 120 requests / 60 s
per IP → 429. Dashboard: Project → Firewall → Configure → New rule → Rate limit. Also consider
Firewall → Bot Management → "AI bots" managed rule (block) if available on Hobby (verify). An
in-memory limiter in `proxy.ts` was rejected: Vercel runs many isolates, so per-instance counters don't
limit anything real, and a DB-backed limiter on every search adds a round-trip to the hot path. Once
the WAF rule is live, the privacy paragraph can add "and the catalog is rate-limited".

## 4. Owner decisions (defaults in the draft)

| # | Decision | Default |
|---|---|---|
| D1 | Block AI-training crawlers? | **Yes**, all listed |
| D2 | Block AI *search/answer* bots (ChatGPT-User, OAI-SearchBot, PerplexityBot, Claude-SearchBot)? | **No** (keeps us visible in AI search; they don't train) |
| D3 | Let search engines index public profiles `/u/`? | **No** (privacy-first) |
| D4 | Forbid ML training on our content in Terms? | **Yes** |
| D5 | Contact for rights holders | `/support` + `NEXT_PUBLIC_SUPPORT_EMAIL` (set to support@nickbolles.com) |
| D6 | Register a US DMCA designated agent ($6, Copyright Office, renew every 3 yrs)? | **Not registered** (draft only; see L4) |
| D7 | Credit users on photos they submit | **Yes**, opt-out |
| D8 | Catalog facts survive account deletion, unattributed | **Yes** (already true per privacy page) |
| D9 | WAF rule limits | 120 req/60 s/IP on `/api/bottles*` |
| D10 | Offer an official data licence / API later? | Not now; "ask us" in Terms |

## 5. Open questions for a lawyer

- **L1 CC BY 4.0 "no additional restrictions"**: does a blanket no-scraping/no-bulk-download clause
  covering pages that *include* CC BY Iowa/WHISKY:EDITION data breach §2(a)(5)(B), given the carve-out
  sentence and that the data is freely available at source? Is the carve-out enough?
- **L2 ODbL**: is the isolated, non-public OFF lookup cache a "Derivative Database" that is "Publicly
  Used" (it influences which catalog match a user sees)? Is the /sources notice sufficient for produced
  works? What must change if we ever merge OFF rows?
- **L3 Database rights**: we're US-operated but EU/UK users can see the catalog. Is a sui generis
  database right claim (EU Database Directive) realistic for a compilation built largely from public
  sources plus our own matching/profiles? Worth stating, or just rely on contract + compilation copyright?
- **L4 DMCA safe harbour**: §512(c) protection requires a designated agent registered with the Copyright
  Office ($6) and a repeat-infringer policy. Should we register before launch? Is `/support` an
  acceptable notice channel or do we need a postal address + named agent on the page?
- **L5 Browsewrap enforceability**: Terms are linked, not clicked-through. Do anti-scraping terms bind
  bots/non-users (cf. *hiQ v. LinkedIn*, *Meta v. Bright Data* 2024 — logged-out scraping not bound by
  terms)? Should account creation add explicit assent ("By continuing you agree…")? Is the CFAA/
  trespass-to-chattels angle worth stating?
- **L6 AI-training prohibition**: enforceability against crawlers that never accepted the terms; any
  value in a TDM reservation under EU DSM Directive Art. 4(3) (machine-readable opt-out — robots.txt
  plus maybe a `TDM-Reservation` header / `ai.txt`)?
- **L7 User content licence**: is "only to run Caskfolk, only to the chosen audience" too narrow for
  future features (share cards, marketing screenshots, app-store listings)? Need sublicence to
  processors (hosting, AI provider)? Moral-rights waiver for UK/EU users?
- **L8 User-submitted bottle photos**: warranty that the user took it / has rights; how to handle label
  artwork copyright in a user's photo of a bottle (incidental?).
- **L9 Unverified source terms**: Systembolaget community mirror, Oregon OLCC, Utah DABS, Vinmonopolet
  API — any attribution or reuse restrictions?
- **L10 COLA label images** (still open from DATA_SOURCES.md legal checklist) if ever displayed.
- **L11 Governing law / jurisdiction** — the Terms still lack entity + jurisdiction (env-driven
  banner says so).

## 6. Not done / follow-ups

- No visual baseline for `/sources` yet (Codex will ask; generate with `[update-baselines]` when the
  draft is approved — avoids burning Vercel deploys / baseline churn on a draft).
- Footer/settings link to `/sources` not added (Terms + privacy link to it).
- PR #134 (logos) will need its per-image credits to match the "Images and logos" paragraph — it already
  does per its `license.ts`.
- WAF rule is a dashboard change for the owner.

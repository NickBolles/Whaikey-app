# App Privacy (Apple) and Data safety (Play) — draft answers

Derived from the code, not from intent: `ACCOUNT_DATA` in `src/lib/account-data.ts`
(the authoritative inventory, enforced by tests against the schema), `/privacy`, and the
outbound calls listed below. Re-derive whenever `ACCOUNT_DATA` changes (track D7 adds a
generator + a test that fails on an undisclosed table; not built in this pass).

## Facts that drive every answer

- **No tracking.** No ad SDKs, no third-party analytics, no cross-app identifiers, no
  data brokers. ATT prompt not required. Nothing is sold.
- **Sign-in:** Google or Apple only (Better Auth). Provider tokens encrypted at rest and
  swept daily (`sweepProviderTokens`).
- **Processors:** hosting + Postgres (Vercel, Supabase); AI provider (OpenRouter or
  Anthropic) for concierge, label scans and note extraction; Apple/Google push services
  if notifications are on; Sentry **only if `SENTRY_DSN` is set** (no PII by default,
  user id attached).
- **First-party measurement:** `ai_usage` (meter readings), `share_events`, scan
  telemetry (#97, anonymous), `analytics_events` — product interaction, linked to the
  user id where noted, retained 90 days.
- **Encrypted in transit:** yes (HTTPS only). **Deletion:** in app (Settings → Your data)
  and on the web at `/delete-account`. **Export:** JSON/CSV in app.

## Apple — App Privacy label

"Data used to track you": **none**. "Data linked to you":

| Apple data type | Source in code (`ACCOUNT_DATA` key) | Linked | Purposes |
|---|---|---|---|
| Contact Info → Name | `account` (from Google/Apple) | Yes | App functionality |
| Contact Info → Email Address | `account`; support contact (`support_messages`) | Yes | App functionality, customer support |
| Contact Info → Phone Number | `phone_lookups` — **keyed hash + last 2 digits only, optional** | Yes | App functionality (friend finding). Declare: Apple counts hashed identifiers as collected |
| User Content → Photos | Label photos sent to the AI provider for identification; **not stored** by Caskfolk | Yes (processed in a signed-in request) | App functionality |
| User Content → Other User Content | `shelf`, `pours`, `tasting_notes`, `concierge_*`, `comments_written`, `profile`, `bottle_submissions` | Yes | App functionality |
| User Content → Customer Support | `support_messages` | Yes | Customer support |
| Purchases → Purchase History | `shelf` purchase price the user types (judgement call — it is user-entered, not an in-app purchase; declaring is the conservative answer) | Yes | App functionality |
| Identifiers → User ID | account id; attached to Sentry reports when enabled | Yes | App functionality, (diagnostics) |
| Identifiers → Device ID | `push_devices` push token (only if notifications on) | Yes | App functionality |
| Usage Data → Product Interaction | `share_events`, `events_on_your_share_links`, `ai_usage`, `analytics_events` | Yes | Analytics, app functionality |
| Diagnostics → Crash / Performance Data | Sentry, **only if `SENTRY_DSN` configured** | Yes | App functionality |
| Other → Other Data Types | `age_answer` (date of birth, market) | Yes | App functionality (legal age gate) |
| Sensitive Info / Health / Location / Contacts / Browsing / Search history / Financial (cards) | — | — | **Not collected** (no location, no contacts API, no payments) |

Also collected but not separately classed by Apple: `sessions` (IP address, user agent —
security), covered under App functionality/Identifiers. If the reviewer questionnaire
asks about IP: "Collected for security and session management, not for tracking."

## Google Play — Data safety form

- Does the app collect or share user data? **Yes, collects. Shares: No** (processors
  acting on our behalf — hosting, AI provider, push, Sentry — are "service providers",
  which Play does not count as sharing).
- Encrypted in transit? **Yes.** Users can request deletion? **Yes** — in app and
  `https://{{DOMAIN}}/delete-account`.
- Committed to Play Families policy? **No** (18+ app).

| Play category → type | Collected | Optional? | Purposes |
|---|---|---|---|
| Personal info → Name | Yes | Required (from sign-in) | Account management, App functionality |
| Personal info → Email address | Yes | Required | Account management, Developer communications (support replies only) |
| Personal info → Phone number | Yes (hashed) | **Optional** | App functionality |
| Personal info → User IDs | Yes | Required | Account management, App functionality |
| Personal info → Other info (date of birth) | Yes | Required (age gate) | App functionality, Compliance |
| Financial info → Purchase history | Yes (prices the user types) | Optional | App functionality |
| Photos and videos → Photos | Yes — processed, not stored (ephemeral) | Optional | App functionality |
| App activity → App interactions | Yes | Required | Analytics |
| App activity → Other user-generated content | Yes | Optional | App functionality |
| App info and performance → Crash logs / Diagnostics | Yes **only if Sentry is enabled** | Required | App functionality |
| Device or other IDs | Yes (push token) | Optional | App functionality |
| Location, Contacts, Messages, Audio, Files, Calendar, Health, Web browsing | No | — | — |

> Check before submitting: if `SENTRY_DSN` is set in production, keep the diagnostics
> rows; if not, remove them. The same applies to any analytics added later.

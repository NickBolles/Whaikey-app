# Store compliance pack (drafts)

Everything here is a **draft for the owner to approve**. Nothing in this folder is
uploaded by any pipeline: it deliberately lives in `docs/store/`, not
`fastlane/metadata/`, so `fastlane deliver`/`supply` cannot publish placeholder copy.
Once approved, copy the final text into App Store Connect / Play Console (or move it
to `fastlane/metadata/` and wire `deliver` — an owner decision).

| File | What it answers |
|---|---|
| [listing.md](listing.md) | Name, subtitle, keywords, descriptions, promo text (both stores) |
| [age-rating.md](age-rating.md) | Apple age-rating questionnaire, Play IARC + target audience |
| [data-disclosures.md](data-disclosures.md) | Apple App Privacy label and Play Data safety, derived from `ACCOUNT_DATA` and the code's real data flows |
| [guideline-4.2.md](guideline-4.2.md) | "Wrapped website" (4.2) inventory: native capabilities shipped, cheap wins done, the rest |
| [review-notes.md](review-notes.md) | Notes for App Review / Play app access, plus export compliance |
| [screenshots.md](screenshots.md) | Screenshot shot list and sizes |

## Placeholders (owner decisions pending)

These appear verbatim in the drafts and must be replaced before submission:

| Placeholder | Decision | Where it is set in code |
|---|---|---|
| `{{DOMAIN}}` | Production domain (roadmap D2) | `NEXT_PUBLIC_APP_URL`, `CAP_SERVER_URL`, `BETTER_AUTH_URL` |
| `{{LEGAL_ENTITY}}` | Developer / seller name (D9) | `NEXT_PUBLIC_LEGAL_ENTITY` |
| `{{SUPPORT_EMAIL}}` | Support contact (D9) | `NEXT_PUBLIC_SUPPORT_EMAIL` (see `src/lib/legal.ts`) |
| `{{REVIEWER_ACCESS}}` | Reviewer access method (D4) | not built — see `APP_STORE_SETUP.md` §6.4 |
| `{{BUNDLE_ID}}` | Final bundle id / package (irreversible) | `capacitor.config.ts` (`com.whaikey.app` today) |

## Public URLs the listings need

- Privacy policy: `https://{{DOMAIN}}/privacy`
- Support: `https://{{DOMAIN}}/support`
- Terms: `https://{{DOMAIN}}/terms`
- **Account deletion (Play, required):** `https://{{DOMAIN}}/delete-account` — public,
  ungated, works signed out (sign in → one button, or an email-verified request into
  the `/admin/feedback` queue, tagged `deletion-request`).

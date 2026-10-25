# Age rating answers (draft)

Rule: answer honestly and take whatever rating the questionnaire returns. Under-rating
an alcohol app is a rejection and a trust problem (APP_STORE_SETUP.md §6.2).

## Apple (2025+ questionnaire; tiers 4+/9+/13+/16+/18+)

| Question | Answer | Why |
|---|---|---|
| Alcohol, tobacco or drug use or references | **Frequent / intense** | Whiskey is the subject of the app |
| Encourages consumption | **No** | No streaks, volume badges or consumption leaderboards (SOCIAL.md §3.1); no pour-nudging notifications |
| Simulated gambling / contests | No | |
| Violence, horror, sexual content, nudity, profanity | None | UGC is moderated (see below) |
| Medical / treatment information | No | `/responsible` links to support resources only |
| User-generated content | **Yes** | Notes shared to friends/public, comments, cheers, profiles |
| — moderation | Report flow (`/api/social/reports`), block, operator queue `/admin/reports` with 72 h target, published policy in `/terms` | |
| Messaging / chat between users | No direct messages (comments on notes only) | |
| Unrestricted web access | **No** | The WebView loads the app's own origin; there is no general-purpose browser in the app (verify external-link behaviour on device before answering) |
| Age assurance / gate in app | Yes — date-of-birth gate on first use (`/age`, 21 in US, 18 default) | |

**Expected result: 18+.** Also set App Store availability consistently and review
countries that restrict alcohol-related apps.

## Google Play

- **IARC questionnaire:** category "Reference, News, or Educational"/"Social" as
  offered; answer *alcohol references: yes*, *encourages use: no*, *UGC: yes, moderated*,
  *users can interact: yes*, *shares location: no*, *digital purchases: no*.
  Expect Mature 17+ / PEGI 18 / USK 18 depending on region.
- **Target audience and content:** **18+ only.** Do not select any under-18 bracket
  (Families policy). Not designed for children.
- **Ads:** No. **News app:** No. **Financial features:** No. **Health:** No.
- **Government app:** No.
- **Alcohol policy:** the app does not sell or facilitate the sale of alcohol.

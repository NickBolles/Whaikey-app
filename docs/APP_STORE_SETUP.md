# App Store Setup Runbook (Apple + Google)

Everything needed to get Whaikey from a signed build to a live store listing, written as
an executable checklist. It is deliberately literal — it is meant to be handed to an
agent with browser access, or followed by a human who has never shipped an app.

> Architecture and phase context: [NATIVE_APP.md](./NATIVE_APP.md).
> **Do not start §5 or §11 (submission) before Phase 3** — see NATIVE_APP.md §6.1.

---

## 0. What can and cannot be delegated

Read this first if you're an agent.

**A browser agent can do:** create app records, fill store listings, upload assets,
complete the age-rating and data-safety questionnaires, configure TestFlight groups,
manage testers, write release notes, submit for review.

**A human must do (do not attempt):**
- Any **payment** (Apple $99/yr, Google $25 one-time).
- **Accepting legal agreements** (Apple Program License Agreement, Paid Apps Agreement,
  Google Developer Distribution Agreement) — these are binding contracts.
- **Identity verification** (Apple's D-U-N-S / ID check, Google's identity + address verification).
- **2FA prompts** on the Apple ID and Google account.
- **Signing key generation and custody** (see §4.3 — losing the Android upload key is unrecoverable).
- **Tax and banking forms** (required before any paid tier ships).

When you hit one of these, stop and hand back with a clear statement of what's needed.
Never enter payment details, and never accept an agreement on someone's behalf.

---

## 1. Decisions to lock before touching a console

Fill these in. Several are irreversible once an app record exists.

| Field | Value | Notes |
|---|---|---|
| App name (store) | `Whaikey` | Must be unique on the App Store. Check availability first — reserving the name in App Store Connect claims it. |
| Subtitle (Apple, 30 chars) | e.g. `Your bar, your palate` | |
| Bundle ID / Application ID | `com.whaikey.app` | **Irreversible on both stores.** Must match `capacitor.config.ts` `appId`. |
| Production URL | TBD | NATIVE_APP.md §7.1 — the WebView loads this. |
| Support URL | required by Apple | Can be a page on the marketing site. |
| Marketing URL | optional | |
| **Privacy Policy URL** | **required by both** | Must be live and reachable *before* submission. Must cover: account data, tasting notes, photos sent for AI label scanning, analytics. |
| Primary category | `Food & Drink` | Secondary: `Lifestyle`. |
| Copyright | `© 2026 <legal entity>` | |
| Contact for review | name / phone / email | Apple contacts this on rejection. |
| Demo account | email + password, pre-stocked bar | **Critical** — see §6.4. Social-login-only apps get rejected under 2.1 when reviewers can't sign in. |

---

## 2. Apple — enrollment (human)

1. Go to <https://developer.apple.com/programs/enroll/>.
2. Sign in with the Apple ID that will own the app. **Use a dedicated company Apple ID**,
   not a personal one — ownership transfer later is painful.
3. Choose entity type:
   - **Individual/Sole Proprietor** — fastest, no D-U-N-S. Your legal name is the public seller name.
   - **Organization** — requires a **D-U-N-S number** (free from Dun & Bradstreet, allow
     up to ~2 weeks) and legal-entity verification. The company name is the public seller.
     Choose this if the app will ever be sold or transferred.
4. Pay **$99/year**. Approval is typically 24–48h for individuals, longer for organizations.
5. In <https://appstoreconnect.apple.com> → **Agreements, Tax, and Banking**, accept the
   Free Apps agreement. If a paid tier is planned (PLAN.md §6), also complete the Paid
   Apps agreement plus tax and banking forms — these gate IAP entirely and take days.
6. Enroll in the **Apple Small Business Program** (<https://developer.apple.com/app-store/small-business-program/>)
   — drops commission 30% → 15% for under $1M/yr. Free, one-time, and materially changes
   the pricing math (NATIVE_APP.md §6.3).

**Blocked until:** enrollment shows "Active."

---

## 3. Apple — register the app

1. **Identifier:** <https://developer.apple.com/account/resources/identifiers/list> →
   `+` → App IDs → App → Description `Whaikey`, Bundle ID **Explicit** `com.whaikey.app`.
2. Enable capabilities on the identifier (must match the Xcode project):
   - ✅ Push Notifications
   - ✅ Sign in with Apple
   - ✅ Associated Domains (Universal Links for `app.whaikey.com`)
   - ✅ In-App Purchase (auto-enabled; needed for Phase 4)
3. **App record:** <https://appstoreconnect.apple.com> → My Apps → `+` → New App
   - Platform: iOS · Name: `Whaikey` · Primary language · Bundle ID: the one above
   - SKU: `whaikey-ios-001` (internal only, never shown)
   - User Access: Full Access
4. **Push key (APNs):** Certificates, IDs & Profiles → Keys → `+` → enable
   **Apple Push Notifications service** → download the `.p8` **once** (it cannot be
   re-downloaded). Record the Key ID and Team ID. Store the `.p8` in the team secret
   manager, never in the repo.

---

## 4. Apple — build and signing

### 4.1 Produce the build
```bash
pnpm native:sync                       # copies web assets + syncs plugins
npx cap open ios                       # opens Xcode (macOS required)
```
In Xcode: select the `App` target → Signing & Capabilities → your Team → confirm the
capabilities from §3.2 are present → set the version and build number → Product ▸
Archive → Distribute App ▸ App Store Connect ▸ Upload.

### 4.2 Info.plist permission strings (required — the app is rejected without them)
Set these in the iOS project before archiving:

| Key | String |
|---|---|
| `NSCameraUsageDescription` | `Whaikey uses the camera to scan bottle barcodes and read labels so you can shelve bottles in seconds.` |
| `NSPhotoLibraryUsageDescription` | `Choose a photo of a bottle label for Whaikey to identify.` |
| `NSMicrophoneUsageDescription` | `Record a spoken tasting note; Whaikey turns it into structured flavor notes.` (only if voice notes ship) |
| `NSFaceIDUsageDescription` | `Unlock your collection with Face ID.` (only if biometric lock ships) |

Write the *reason*, not the permission. "This app needs camera access" gets rejected.

### 4.3 Key custody (human, do this once, carefully)
- **iOS:** let Xcode manage signing. The distribution certificate is recoverable via the
  Apple account, so this is low-risk.
- **Android:** enroll in **Play App Signing** (default for new apps). Google holds the
  app signing key; you hold the *upload* key. **Back up the upload keystore and its
  passwords in the team secret manager.** Losing it without Play App Signing enrolled
  means you can never update the app again.

---

## 5. Apple — TestFlight

1. App Store Connect → your app → TestFlight. The uploaded build appears after
   processing (~5–30 min).
2. Complete **Export Compliance**. Whaikey uses HTTPS only and no proprietary
   cryptography → answer that it uses encryption, and that it qualifies for the exemption
   for standard/HTTPS encryption. (Setting `ITSAppUsesNonExemptEncryption = false` in
   Info.plist answers this permanently and skips the prompt on every build.)
3. **Internal testing** (up to 100 users on your team, no review): add testers, ship.
4. **External testing** (up to 10,000): requires a short Beta App Review — usually under
   24h and much lighter than full review. Fill in the beta description and feedback email.
5. Run the device smoke list in NATIVE_APP.md §5 on at least one real iPhone before
   moving on.

---

## 6. Apple — store listing and compliance

### 6.1 Assets (specs in §11)
Icon, screenshots, description, keywords, promotional text, support URL, privacy policy URL.

### 6.2 Age rating — read this carefully
Apple's questionnaire was overhauled in 2025; ratings are now **4+ / 9+ / 13+ / 16+ / 18+**,
and every app had to answer the updated questions by **31 Jan 2026** to keep submitting
updates. ([Apple Developer News](https://developer.apple.com/news/?id=ks775ehf))

Whaikey is an alcohol app. **Answer honestly — under-rating is a rejection and a
trust problem.** Expect the alcohol/tobacco/drugs question to drive the rating to **16+
or 18+**; take whatever the questionnaire returns rather than trying to tune it down.
Also relevant on the current questionnaire:
- References to alcohol: **yes, frequent/intense** (it is the subject of the app).
- Does the app encourage consumption? **No** — and PLAN.md §7's responsible-drinking
  stance is worth stating in the review notes.
- User-generated content / social feed: **no** for v1 (that's PLAN.md Phase 4). Revisit
  when social ships — Apple's UGC questions become mandatory in Sept 2026 and force 13+
  minimum with moderation and blocking requirements.

Set the **App Store availability age gate** consistently, and check whether any target
country restricts alcohol-related apps outright.

### 6.3 App Privacy (the nutrition label)
Declare every data type collected. For Whaikey at minimum:

| Data type | Collected | Linked to user | Used for tracking | Purpose |
|---|---|---|---|---|
| Email address | Yes | Yes | No | App functionality (account) |
| Name | Yes | Yes | No | App functionality |
| Photos (label scans) | Yes | Yes | No | App functionality — sent to the AI provider for identification |
| User content (tasting notes, inventory) | Yes | Yes | No | App functionality |
| Purchases (bottle prices entered by the user) | Yes | Yes | No | App functionality |
| Product interaction / crash data | Yes | Yes | No | Analytics, app functionality |
| Identifiers | Yes | Yes | No | App functionality (push token) |

If PostHog/Sentry are added, re-check the "tracking" column — enabling cross-app
tracking triggers the **App Tracking Transparency** prompt requirement. Don't enable it
unless there's a reason.

### 6.4 Review notes — this is where hybrid apps are won or lost
Paste something close to this into "Notes for Review":

> Whaikey is a whiskey collection tracker. Sign-in is social-login only, so please use
> the demo account below — it has a stocked bar and tasting history.
>
> Demo account: `<email>` / `<password>`
>
> Native functionality to try:
> • Scan tab — native MLKit barcode scanning (camera permission), rapid batch scanning
> • Scan tab shutter — native camera label capture, identified on-device→server
> • Any rating or flavor-wheel tap — haptic feedback
> • Log a pour in airplane mode — it queues locally and syncs on reconnect
> • Push notifications for wishlist price alerts
>
> The app does not encourage alcohol consumption; it has no features that reward
> drinking frequency, and it surfaces no consumption prompts.

Include the demo account **and verify it works right before submitting**. An expired
demo account is the most common avoidable rejection.

---

## 7. Apple — submit

1. Select the build, complete every red-flagged field, Add for Review → Submit.
2. Expect **24–48h** for a first review; first submissions get more scrutiny.
3. On rejection: read the guideline number, reply in Resolution Center (you can argue —
   politely and specifically), fix, resubmit. A 4.2 rejection is answered by naming the
   native capabilities from §6.4, not by rewording the description.

---

## 8. Google Play — enrollment (human)

1. <https://play.google.com/console/signup> — pay **$25, one-time**.
2. Choose **Organization** if a legal entity exists; personal accounts hit the closed-testing
   requirement in §10.
3. Complete **identity verification** (government ID and/or D-U-N-S for organizations).
   Allow several days. Your developer name and address become public.
4. Accept the Developer Distribution Agreement (human).

**Note the account-age rule:** personal accounts created after 13 Nov 2023 must run a
closed test with **12 opted-in testers for 14 consecutive days** before production access
is granted. Organization accounts are exempt.
([Google Play policy](https://support.google.com/googleplay/android-developer/answer/14151465))

---

## 9. Google Play — create the app

1. Play Console → **Create app**: name `Whaikey`, language, App (not Game), Free,
   accept declarations.
2. **Dashboard → Set up your app** — work top to bottom; every item gates release:
   - **App access** — social login only, so provide the demo credentials from §1. Same
     rule as Apple: reviewers who can't sign in reject.
   - **Ads** — no (unless affiliate links count for you; disclosed affiliate links in
     content are not "ads" in this sense, but read the definition).
   - **Content rating** — IARC questionnaire. Same honesty rule as §6.2; alcohol content
     will raise it (typically Teen / PEGI 16+ / USK 16).
   - **Target audience** — **18+ only**. Do **not** include any under-18 bracket; an
     alcohol app in a child-adjacent bracket triggers Families policy review and refusal.
   - **News app** — no. **COVID-19 apps** — no.
   - **Data safety** — mirrors §6.3. Declare data collected, whether encrypted in transit
     (yes), whether users can request deletion (**yes** — PLAN.md guarantees exportable,
     user-owned data; make sure an actual deletion path exists).
   - **Government apps** — no. **Financial features** — no.
   - **Privacy policy** — the URL from §1.
3. **Store listing:** short description (80 chars), full description (4000), assets per §11.

---

## 10. Google Play — testing tracks

1. **Internal testing** — up to 100 testers, available in minutes, no review. Start here.
2. **Closed testing** — required for new personal accounts: **12 testers, opted in, for
   14 continuous days.** "Opted in" means they accepted the invite *and installed*;
   invitations alone don't count. Recruit real testers early — this is a two-week wall
   sitting in front of launch.
3. **Production access application** — a three-section form after the closed test
   completes; review usually ≤7 days.
4. **Production** — staged rollout (start at 10–20%, watch crash-free rate, then ramp).

---

## 11. Asset specifications

Generate icons and splash screens from source art with:
```bash
pnpm native:assets    # @capacitor/assets → all iOS + Android sizes
```
Source files live in `native/assets/`: `icon.png` (1024×1024, **no transparency, no
rounded corners** — Apple rejects alpha channels) and `splash.png` (2732×2732, subject
centered in the middle ~40%, since it's cropped hard across aspect ratios).

**Apple**
| Asset | Spec |
|---|---|
| App icon | 1024×1024 PNG, no alpha, no rounded corners |
| iPhone screenshots | 6.9" display set (1290×2796 or 1320×2868), 2–10 images. App Store Connect scales down for smaller devices, so one set is the practical minimum. Verify current requirements in the console — Apple changes these. |
| iPad screenshots | Only if the app ships iPad support (NATIVE_APP.md §7.4 proposes skipping it for v1) |
| App preview video | Optional, 15–30s |
| Description | 4000 chars · Subtitle 30 · Promotional text 170 · Keywords 100 (comma-separated, no spaces) |

**Google**
| Asset | Spec |
|---|---|
| App icon | 512×512 PNG, 32-bit with alpha |
| Feature graphic | 1024×500 PNG/JPEG — **required**, shown at the top of the listing |
| Phone screenshots | 2–8, 16:9 or 9:16, each side 320–3840px |
| Tablet screenshots | Only if tablet support is declared |
| Short description | 80 chars · Full description 4000 |

**Screenshot content tips:** show the scan flow, My Bar, the flavor wheel, and the AI
concierge — the four things that differentiate the product. Caption each one. Screenshots
sell more than the description does.

---

## 12. Automation (optional, Phase 4+)

- **Fastlane** (`deliver` / `supply`) scripts metadata, screenshots, and uploads for both
  stores from CI. Worth it by the third release.
- **Xcode Cloud** or **Codemagic** for macOS build agents if no Mac is available.
- Store all signing material (`.p8`, keystore, App Store Connect API key) in the CI
  secret store. **Never commit them** — the repo's `.gitignore` covers the generated
  platform directories, but keys must never reach a working tree in the first place.

---

## 13. After launch

- Watch crash-free rate on both consoles for 72h; staged rollout means you can halt.
- Reply to reviews — both stores weight developer responsiveness.
- Apple requires annual re-acceptance of agreements and periodic age-rating requestionnaires;
  a lapsed agreement silently blocks updates.
- Keep a `RELEASING.md` once the first release is done, recording what actually happened
  — every one of these consoles changes its UI within months of this document being written.

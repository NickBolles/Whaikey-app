# Whaikey Native App Plan (Capacitor)

How Whaikey becomes an iOS + Android app without forking the product.

> Companion doc: [APP_STORE_SETUP.md](./APP_STORE_SETUP.md) — the step-by-step store onboarding runbook.
> Context: [PLAN.md](../PLAN.md) §4 (architecture), §5 (roadmap), §6 (monetization).

---

## 1. The decision: Capacitor, not React Native

PLAN.md §4.1 originally proposed **React Native + Expo**. That was written before any
code existed. What actually shipped is a Next.js 16 App Router web app — and that
changes the answer.

### 1.1 What we're actually starting from

| Asset | Size | Portable to React Native? |
|---|---|---|
| 12 route trees / 15 page + client files | ~4.5k LOC | ❌ Full rewrite (DOM → RN primitives) |
| 20 UI components (Tailwind v4 + SVG) | ~2.6k LOC | ❌ Rewrite; SVG charts need `react-native-svg` |
| `src/lib/*` domain logic (palate, recommend, search, bar, scan, import) | ~2.3k LOC | ⚠️ Server-side + Drizzle-coupled — stays on the server either way |
| `src/lib/flavor-wheel.ts` + `wheel-geometry.ts` | ~430 LOC | ✅ Pure math/data, portable |
| 30+ Vitest suites (jsdom + Testing Library) | — | ❌ Rewrite against `@testing-library/react-native` |
| Playwright visual-regression baselines (docs/DESIGN.md workflow) | — | ❌ Does not apply to RN |
| API routes + Better Auth + Drizzle | — | ✅ Unchanged under either choice |

The honest read: **React Native rewrites ~7k lines of UI and the entire test/visual
harness, and buys nothing on the server.** Estimated 6–10 weeks to parity, then a
permanent ~2× cost on every UI change (web app + native app), or the web app is
abandoned.

### 1.2 What each option actually buys

**React Native / Expo**
- ✅ Genuinely native scroll momentum, gestures, keyboard handling, nav transitions.
- ✅ No WebView memory ceiling; better perf on very long lists.
- ✅ EAS Build/Submit/Update is the best-in-class native CI + OTA pipeline.
- ✅ Deepest native module ecosystem.
- ❌ Full UI rewrite; two UIs forever (unless web is dropped).
- ❌ Loses the visual-regression safety net that docs/DESIGN.md is built around.

**Capacitor**
- ✅ Ships the existing app as-is. One codebase, one design system, one test suite.
- ✅ Full native SDK access via plugins — the native surface we actually need is narrow.
- ✅ UI updates ship without App Store review (see §2.2).
- ✅ Escape hatch: you can write custom native code per-platform, or port screen-by-screen later.
- ❌ UI is a WebView: scroll/keyboard/transitions are "web-good", not "native-great".
- ❌ No OTA for native code; JS updates only via the remote-URL model (§2.2).
- ⚠️ App Store guideline 4.2 risk if the app is only a repackaged website (§6.1).

### 1.3 Why Capacitor wins *for this product*

The deciding argument isn't "which framework is better." It's that **Whaikey's
differentiators are server-side and its native-critical surface is narrow**:

- The AI concierge, catalog search, palate model, and recommendations are all API calls.
  React Native would render those responses more smoothly; it would not make them better.
- The genuinely native needs are a short list: **barcode/camera scanning, haptics,
  offline pour logging, push, share, widgets, IAP**. Capacitor delivers 100% of that
  list at roughly 5% of the migration cost.
- Whaikey's screens are lists, cards, forms, and SVG charts. Those are exactly the
  screens a WebView renders well. RN's advantage concentrates in gesture-heavy,
  animation-heavy UI — which this app doesn't have.

**One immediate, concrete win:** the current scanner (`src/app/scan/scan-client.tsx`)
uses the `BarcodeDetector` Web API, which **does not exist in WKWebView** — barcode
scanning is silently broken for every iOS user today, on web and in any WebView. The
Capacitor MLKit plugin fixes iOS scanning as a side effect of going native. That single
plugin makes the core loop work on the platform that matters most for this audience.

### 1.4 Tripwires — when to revisit React Native

Write these down now so the decision gets re-examined on evidence, not vibes:

1. App Store review rejects twice under guideline 4.2 despite the native feature set (§6.1).
2. Scan-to-shelved p95 exceeds 3s on a mid-tier Android device (the PLAN.md §1 "under 10 seconds" promise starts to wobble).
3. My Bar scroll drops frames for users with 300+ bottles, and virtualization doesn't fix it.
4. A must-have feature turns out to be genuinely unbuildable through a plugin.

If a tripwire fires, the migration is **incremental, not all-or-nothing**: Capacitor
apps can host RN views, and the API layer is already the seam.

### 1.5 Learnings worth keeping

- **Pick the shell after you know the app.** The 2024 plan said Expo; the 2026 codebase
  says Capacitor. Framework choices made before the code exists are guesses.
- **"Cross-platform" is a property of the API layer, not the UI layer.** The reason
  either option works here is that all state lives behind HTTP.
- **A WebView is not automatically a worse app — a *featureless* WebView is.** The 4.2
  rejections that people write blog posts about are apps with zero native integration.
- **The native gap in a web app is usually one API, not the whole platform.**
  `BarcodeDetector` was the gap. That's a plugin, not a rewrite.

---

## 2. Architecture

### 2.1 Shape

```
┌─────────────────────────── Native app (iOS / Android) ────────────────────────────┐
│                                                                                   │
│  Capacitor runtime                                                                │
│   ├── WKWebView / Android WebView ──▶ loads https://app.whaikey.com (server.url)   │
│   │      └── the existing Next.js app, unchanged                                  │
│   ├── Bundled web assets (native/shell/) ──▶ offline + boot fallback (errorPath)   │
│   └── Native plugin bridge                                                        │
│         MLKit barcode · Camera · Haptics · Push · Share · Preferences              │
│         StatusBar · SplashScreen · Keyboard · App (deep links, back button)        │
│                                                                                   │
└───────────────────────────────────────┬───────────────────────────────────────────┘
                                        │ HTTPS (first-party cookies — same origin)
                                        ▼
                          Next.js on Vercel  ──▶  Postgres · Better Auth · Claude
```

`src/lib/native/` is the seam. Every plugin is reached through it, every function has a
web fallback, and nothing in `src/app` or `src/components` imports `@capacitor/*`
directly. The web build is byte-for-byte unaffected by the native work.

### 2.2 Why remote-URL, and what it costs

Three options were on the table:

| | A. Remote URL (**chosen**) | B. Static export bundled | C. Bundled shell + remote |
|---|---|---|---|
| Server components / `force-dynamic` | ✅ work as-is | ❌ must all become client-fetch | ✅ |
| Cookie auth | ✅ first-party, zero changes | ❌ needs bearer tokens + CORS | ✅ |
| Migration cost | ~0 | rewrite all 12 routes | ~0 |
| Cold start | network-bound | instant | network-bound |
| Works fully offline | ❌ | ✅ | partial |
| UI updates without review | ✅ | ❌ | ✅ |

**We ship C** — which is A plus a bundled fallback: `server.url` points at production,
and `webDir` still packages a small local shell used as `server.errorPath`, so a user
with no signal gets a Whaikey-branded offline screen (and, from Phase 3, a queue of
pours waiting to sync) instead of a WebView error page.

Two consequences to be deliberate about:

- **Upside: no App Store review for UI changes.** A Vercel deploy updates every
  installed app instantly. This is legitimate — Apple permits it for web content — and
  it is a large velocity win over both RN (store review, or EAS Update's own
  constraints) and option B.
- **Downside: a bad production deploy bricks the installed app**, and there is no
  version pinning. Mitigation in Phase 2: the shell checks a `/api/native/manifest`
  endpoint for a `minShellVersion`; if the deployed web app requires a newer native
  shell than the installed one, the app shows an "Update Whaikey" screen instead of a
  broken UI. This also gives us a kill switch for a bad deploy.

Option B stays documented as the Phase 5 escape hatch if offline-first becomes the
product priority — see §4, Phase 5.

### 2.3 Authentication — the one genuinely hard part

Not hard because of Capacitor; hard because **Google blocks OAuth in embedded
WebViews** (`disallowed_useragent`). Sign-in cannot happen inside the app's WebView.
And the system browser (`ASWebAuthenticationSession` / Chrome Custom Tabs) does *not*
share its cookie jar with WKWebView, so completing OAuth in the browser doesn't sign
you in inside the app.

The working pattern, to be built in Phase 2:

```
1. Tap "Continue with Google"
   → native detects it's in-app → opens @capacitor/browser to
     https://app.whaikey.com/api/auth/native/start?provider=google
2. Full OAuth runs in the system browser (Google is happy: real browser).
3. Better Auth callback lands on the server, which mints a single-use,
   short-TTL (≤60s) exchange code bound to that session.
4. Server redirects to whaikey://auth/callback?code=…
   → the custom scheme wakes the app; @capacitor/app's appUrlOpen fires.
5. The app navigates the *WebView* to
   https://app.whaikey.com/api/auth/native/exchange?code=…
   That navigation happens inside the WebView, so the Set-Cookie response
   lands in the WebView's cookie store. Session established. Redirect home.
```

Why this and not the alternatives:

- **Bearer tokens everywhere** (Better Auth's `bearer()` plugin) works, but requires
  every server component and API route to accept a header instead of a cookie — that's
  option B's cost without option B's benefits.
- **Sign in with Apple** gets a shortcut: the native SDK returns an identity token
  directly, no browser round-trip, and it's the flow Apple expects. Worth doing
  natively even though the exchange endpoint would also work. Note Apple requires
  Sign in with Apple to be offered wherever a third-party social login is offered.

Security requirements on the exchange endpoint (write these into the implementation):
single-use, ≤60s TTL, bound to the originating session and provider, rate-limited, and
the code never logged. Register `whaikey://` on both platforms plus Universal
Links / App Links for `https://app.whaikey.com/*` so shared bottle URLs open the app.

### 2.4 Repo layout

```
capacitor.config.ts        # Capacitor config (server.url from env at build time)
native/
  shell/                   # bundled webDir: the offline fallback page (no build step)
  assets/                  # icon.svg / splash.svg sources; PNGs rendered by native:assets
ios/                       # generated by `cap add ios`     — gitignored until Phase 2
android/                   # generated by `cap add android` — gitignored until Phase 2
scripts/native-*.mjs       # check / sync / asset generation
src/lib/native/
  platform.ts              # isNativeApp(), platform detect, safe plugin loading
  haptics.ts  barcode.ts  share.ts  app-chrome.ts  app-lifecycle.ts
src/components/native-shell.tsx   # client component; boots native chrome in layout
```

Scripts:

```bash
pnpm native:check          # validate config (CI-safe: no Xcode, SDK, or network)
pnpm native:assets         # render native/assets/*.svg → app icons, splash, PWA icons
CAP_SERVER_URL=https://… pnpm native:sync   # bake the origin into the shell, cap sync
pnpm native:add:ios        # cap add ios      (Phase 2)
pnpm native:add:android    # cap add android  (Phase 2)
```

`native/ios` and `native/android` are gitignored for now: they are generated, large,
and nothing in Phase 1 requires committing them. They get committed in Phase 2 when
native config (entitlements, Info.plist strings, signing) starts carrying real
information. `cap sync` regenerates them from `capacitor.config.ts` + `package.json`.

---

## 3. Native capability catalog

Everything the native shell unlocks, mapped to the product. Ordered by value.

### 3.1 Core loop (Phase 1–3)

| Capability | Plugin | What it does for Whaikey |
|---|---|---|
| **Barcode scanning** | `@capacitor-mlkit/barcode-scanning` | **Fixes iOS scanning entirely** (no `BarcodeDetector` in WKWebView). Faster and better in low light than the JS loop; keeps the existing rapid-batch queue UX. |
| **Camera / label capture** | `@capacitor/camera` | Full-res label photos, native permission UX, native torch. Feeds `/api/scan-label`. |
| **Haptics** | `@capacitor/haptics` | Scan lock-on, star ratings, flavor-wheel wedge taps, pour saved. The wheel input with per-wedge taptic feedback is a real native delight — replaces `navigator.vibrate` (which iOS ignores). |
| **Offline pour queue** | `@capacitor/preferences` + `@capacitor/network` | PLAN.md §4.2's "a bar basement has no signal". Queue pours locally, flush on reconnect/resume. |
| **Status bar / splash / keyboard / safe areas** | `@capacitor/status-bar`, `splash-screen`, `keyboard` | Table-stakes polish; without it the app reads as a website. |
| **Back button + deep links + resume** | `@capacitor/app` | Android hardware back, `whaikey://` and Universal Links, refresh-on-resume. |

### 3.2 Engagement (Phase 3–4)

| Capability | Plugin / API | Use |
|---|---|---|
| **Push notifications** | `@capacitor/push-notifications` | Wishlist price alerts, blind-tasting session invites, "your Wrapped is ready", catalog-verification results. **Guardrail: never a "time for a drink" nudge** — PLAN.md §7 responsible-drinking stance rules out consumption-frequency prompts. |
| **Share sheet** | `@capacitor/share` | Share a tasting-note card or palate wheel as an image. |
| **Share *extension*** (receive) | custom native | Send a bottle photo or retailer URL *into* Whaikey from any app → straight into the scan flow. |
| **Home screen widgets** | WidgetKit / Glance (custom native) | "Tonight's pour", collection value, open bottles. PLAN.md §2.9 already wants these — and they're the single strongest guideline-4.2 defense. |
| **App shortcuts / quick actions** | custom native | Long-press the icon → "Log a pour" / "Scan a bottle". |
| **Siri Shortcuts / App Intents** | custom native | "Hey Siri, log a pour of Lagavulin 16." |
| **Local notifications** | `@capacitor/local-notifications` | Blind-tasting reveal timer (PLAN.md §2.8). |

#### Notification delivery and settings

One pipeline serves the app and the web, because everything above the transport
— categories, quiet hours, per-device settings, health — is identical for both.
`push_devices` holds APNs/FCM tokens and W3C Push subscriptions side by side
(`platform` is `ios | android | web`); `src/lib/notifications/` owns the rules and
`src/lib/notifications/sender.ts` is the only place that knows a transport, behind
a `getPushSender()` / `setPushSenderForTests()` seam like the AI client's.

Sending goes through `sendNotification()`, which resolves settings in three layers
— category default → account → device — and writes a `notification_deliveries` row
for **every** attempt including the ones it suppresses. That log is the feature:
without it a quiet-hours hold, a muted device, a switched-off category and a dead
subscription all present to the user as the same silence.

Quiet hours are per device by design. Each row carries its own window *and its own
IANA zone*, so a desktop in Denver and a phone in Lisbon resolve "22:00"
differently at the same instant — with `inherit` (follow the account), `off`
(always allow) and `custom` as the three modes. Critical categories (account and
security) bypass quiet hours; a test send does not, because a test that ignored
the setting would prove the wrong thing.

`/settings/notifications` reads all of this and leads with a verdict rather than a
toggle grid: which devices are failing and what to do about each. Missing server
credentials are reported as a first-class state — an unset VAPID or FCM key shows
as "Server not configured" naming the variables, instead of a feature that looks
enabled and silently sends nothing. Keys live in `.env.example` under
**Notifications**.

### 3.3 Depth (Phase 4–5)

| Capability | Use |
|---|---|
| **In-app purchase** (RevenueCat) | **Required** by Apple for the Pro subscription in PLAN.md §6.2. See §6.3 — it changes the pricing math. |
| **Native voice recording** | PLAN.md §2.3's voice notes. `MediaRecorder` in WKWebView is unreliable; native audio is not. |
| **Biometric lock** | Face ID / fingerprint to open. Collection value is sensitive data; also a premium-feeling Pro perk. |
| **Live Activities / Dynamic Island** | A tasting flight in progress. |
| **Apple Watch companion** | One-tap rating during a tasting without pulling out a phone. |
| **Photo library batch import** | Bulk-import shelf photos for collection onboarding. |
| **Screen wake lock** | Keep the screen on during a guided tasting. |
| **NFC shelf tags** | Tap a tag on the shelf to open that bottle. Gimmick, but a cheap one. |

---

## 4. Phases

Each phase is independently shippable. Phase 1 is implemented in this change.

### Phase 0 — Scaffold ✅ (this change)
Capacitor deps and config; `native/shell/` offline page; PWA manifest + icons;
`native:*` scripts; gitignore for generated platform projects.
**Exit:** `pnpm native:sync` succeeds; web build unaffected.

### Phase 1 — Native capability layer ✅ (this change)
`src/lib/native/` bridge with web fallbacks; `NativeShell` mounted in the root layout
(status bar, splash, keyboard, safe areas, Android back button, deep links); scanner
switched to MLKit on native with the `BarcodeDetector` path retained for web; haptics
throughout the scan flow. Full unit coverage.
**Exit:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green; every native
module no-ops correctly under jsdom.

### Phase 2 — It runs on a device ✅ (implemented)
Committed `ios/` and `android/` projects; permission strings, export-compliance flag,
`whaikey://` scheme, associated-domains entitlement, App Links intent filter with an
env-driven host, and the `/.well-known/` verification files both platforms fetch;
Whaikey icon and splash art generated for every density; native auth exchange (§2.3).
**Exit:** `./gradlew assembleDebug` produces an APK with the deep links, permissions,
and MLKit components merged in — verified. Signed builds and the device smoke list
still need real credentials and hardware.

### Phase 3 — Offline + engagement ✅ (partly implemented)
Done: offline pour queue with durable storage, ordered flush on reconnect and resume,
and a visible "saved on your phone" state; push registration + token storage endpoint;
the full delivery pipeline and its settings surface (§3.3).
Remaining: the individual notification *triggers* (a price watcher, a tasting-invite
hook, the Wrapped job) now that there is something to call; real FCM credentials in
production; a share-a-note-card surface, app shortcuts, and an idempotency key on
`/api/pours` so a flush whose response is lost cannot double-log.
**Exit:** log a pour in airplane mode, reconnect, see it sync.

### Phase 4 — Store launch (CI ready, credentials pending)
Done: `.github/workflows/native-release.yml` ships to TestFlight and the Play internal
track via Fastlane, with run-number versioning, env-only signing material, and a
preflight that names any missing secret. CI compiles Android on every PR and iOS on
every push to main.
Remaining (all human/account work — [APP_STORE_SETUP.md](./APP_STORE_SETUP.md)):
enrolment, store records, the secrets in §12, screenshots, closed testing. Then
widgets, IAP via RevenueCat, and Sentry/PostHog native SDKs.
**Exit:** live on both stores.

### Phase 5 — Optional local-first
Only if offline becomes the product priority: migrate the core-loop routes (`/bar`,
`/pour`, `/scan`) to a bundled static export talking to the API with bearer tokens,
keeping the remote-URL model for everything else. This is architecture option B from
§2.2, applied surgically rather than wholesale.

---

## 5. Testing

- **Unit (Vitest):** every `src/lib/native/` module is tested in jsdom with the native
  platform absent — proving the web fallbacks hold and the web bundle never crashes.
  Native-path tests inject a fake plugin registry.
- **Component:** unchanged. The bridge is mockable at the module boundary.
- **Visual regression:** unchanged, still the source of truth for design (docs/DESIGN.md).
  Native chrome (status bar, safe-area insets) is deliberately excluded from baselines —
  it doesn't exist in a desktop Chromium screenshot.
- **Device smoke (manual, per release):** sign in, scan a barcode, log a pour offline,
  reconnect, hardware back button, deep link into a bottle page, background/foreground.
- **CI:** `pnpm native:check` validates the Capacitor config and that the shell bundle
  exists. Native builds are not in CI until Phase 2 (they need signing secrets).

---

## 6. Risks

### 6.1 App Store guideline 4.2 (Minimum Functionality) — the main one

Apple rejects apps that are "a repackaged website." A `server.url` Capacitor app is
exactly the shape that gets flagged, so the defense has to be real, not rhetorical:

- Native MLKit barcode scanning (a real native SDK, and the feature the app is built around).
- Native camera capture with permission flows.
- Haptic feedback throughout.
- Push notifications.
- Offline pour logging that works with no network.
- Sign in with Apple, native.
- Home screen widgets (Phase 4 — ship before first submission if review is at all tight).

**Do not submit before Phase 3.** A Phase-2 build is a WebView with a scanner; a
Phase-3+ build is an app. Also: write the review notes to *name* these capabilities and
give the reviewer a demo account with a stocked bar (see APP_STORE_SETUP.md §6.4) —
reviewers who can't get past sign-in reject on 2.1 instead.

### 6.2 The rest

| Risk | Mitigation |
|---|---|
| A bad prod deploy bricks every installed app | `minShellVersion` manifest + kill switch (§2.2); treat the web app as a released artifact once the native app ships |
| WebView feel (scroll, keyboard, transitions) reads as "website" | Native chrome + haptics + safe areas close most of the gap; RN tripwires in §1.4 catch the rest |
| Google blocks OAuth in the WebView | The system-browser + exchange-code flow in §2.3 — this is a known, solved pattern, but it must be built correctly (single-use, ≤60s, rate-limited) |
| Alcohol content raises the age rating / limits distribution | Expected and fine: rate honestly (APP_STORE_SETUP.md §6.2). The responsible-drinking stance in PLAN.md §7 is an asset in review, not a liability |
| Apple's IAP cut breaks the pricing model | See §6.3 below — resolve before Phase 4 |
| Native project drift between team members | `cap sync` is the source of truth; platform projects committed from Phase 2 so config changes are reviewable |
| MLKit adds significant APK size | Use the Google-Play-services-distributed MLKit variant so the model downloads on demand rather than shipping in the bundle |

### 6.3 Open question: IAP economics

PLAN.md §6.4 targets "AI cost per premium user < $1/mo" against $5.99 revenue. Apple
and Google take **30% (15% under the Small Business / first-$1M programs)**. At 15%,
$5.99 becomes ~$5.09; at 30%, ~$4.19. The §6.4 margin math needs redoing against the
net number before the paywall ships, and the Small Business Program enrollment (Apple)
and equivalent (Google) should be done early — they're free and one-time.

---

## 7. Open questions

1. **Production hostname.** `capacitor.config.ts` reads `NEXT_PUBLIC_APP_URL`; the app
   currently has no committed production domain. Needs deciding before Phase 2.
2. **Bundle ID.** Proposed `com.whaikey.app` — depends on the name question in PLAN.md §7.3.
3. **Android minSdk.** Capacitor 8 defaults to 23; MLKit wants 21+. Default is fine
   unless there's a reason to go lower.
4. ~~**iPad support?**~~ **Decided: iPhone-only for v1.** `TARGETED_DEVICE_FAMILY = 1`
   in the Xcode project. The layout is `max-w-2xl` and mobile-first, and this removes an
   entire screenshot set plus the obligation to make the app work on a 13" canvas.
   Reversing it is a one-line change back to `"1,2"` plus iPad screenshots.
5. **Push provider.** Firebase Cloud Messaging covers both platforms via Capacitor's
   plugin; confirm before Phase 3 that adding Firebase is acceptable alongside the
   existing stack.

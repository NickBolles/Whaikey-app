# Guideline 4.2 ("Minimum Functionality" / wrapped website) inventory

The iOS app is a remote-URL Capacitor shell (`server.url`), which is the shape 4.2
flags. The defence is real native capability, named in the review notes. Status as of
this branch:

## Shipped (native code paths, not web fallbacks)

| Capability | Where | Reviewer can see it at |
|---|---|---|
| Native barcode scanning (ML Kit) | `src/lib/native/barcode.ts` | Scan tab |
| On-device label OCR (Apple Vision / ML Kit) | `src/lib/native/ocr.ts` (#100) | Scan → label shutter |
| **Native Sign in with Apple** (ASAuthorization) | `WhaikeyAppleSignInPlugin.swift`, `src/lib/native/apple-sign-in.ts` (this PR) | Sign-in screen |
| Haptics on choices, scan lock, flavour wheel | `src/lib/native/haptics.ts` | Rating stars, flavour wheel, scan |
| **Haptics on every save / failure toast** | `src/components/toast.tsx` (this PR) | Log a pour, shelve a bottle |
| Native share sheet | `src/lib/native/share.ts` | Pour share, bottle compare |
| Offline pour queue + sync on reconnect | `src/lib/native/offline-queue.ts`, `native-shell.tsx` | Log a pour in airplane mode |
| Bundled offline / unreachable screen with retry | `native/shell/index.html` (Capacitor `errorPath`) | Launch with no network |
| Native splash screen, status bar, keyboard handling | `capacitor.config.ts`, `src/lib/native/app-chrome.ts` | Launch |
| Edge-swipe back gesture | `SceneDelegate.swift` | Any pushed screen |
| Push registration with contextual permission prompt (Settings toggle, never at launch) | `src/lib/native/push.ts`, `settings/notifications-card.tsx` | Settings → Notifications |
| Deep links / Universal Links | `App.entitlements`, `.well-known` routes | Shared bottle link |
| Shell version gate / update screen | `src/lib/native/manifest.ts`, `shell-update-required.tsx` | — |

## Not done — documented, ordered by value / cost

1. **Push transport** (D4: FCM HTTP v1 + outbox). Registration exists; nothing is sent
   yet, so do not claim "push notifications" in review notes until D4 lands.
2. **Native-launcher version gate before load** (D3) — today the gate runs after the
   web app loads.
3. **Pull-to-refresh** on feed and Bar (D11).
4. **Offline shell listing queued pours** — the offline screen explains and retries,
   but does not list pours queued on the device (D11).
5. **Home-screen widget** (NATIVE_APP.md §6.1) — strongest single 4.2 argument if
   review is tight; needs a WidgetKit extension target (Xcode work).
6. **Splash-to-paint < 2 s** measurement on a mid device (needs a device).
7. Keyboard / safe-area audit on a notch + Dynamic Island device (needs a device).

## Review-notes sentence (keep in sync with `review-notes.md`)

> Whaikey uses native barcode scanning, on-device label text recognition, native Sign in
> with Apple, haptic feedback, the native share sheet, and an offline pour queue that
> syncs when the device reconnects.

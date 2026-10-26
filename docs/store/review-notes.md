# Review notes and app access (draft)

## Apple — Notes for Review

```
Caskfolk is a whiskey collection and tasting journal for adults (18+).

Sign-in: Sign in with Apple (native) or Google. Reviewer access: {{REVIEWER_ACCESS}}
The reviewer account has a stocked bar, tasting notes, friends and a shared note.

Native functionality to try:
• Scan tab — native barcode scanning (camera permission requested on first use).
• Scan → label photo — on-device text recognition identifies the bottle.
• Sign-in screen — native Sign in with Apple sheet.
• Log a pour or shelve a bottle — haptic confirmation; rating stars and the flavour
  wheel also use haptics.
• Share a pour — native share sheet.
• Turn on airplane mode and log a pour — it is queued on the device and syncs when you
  reconnect. Launching with no network shows a native offline screen with retry.

Responsible use: the app never rewards drinking frequency or volume — no streaks,
volume badges or consumption leaderboards. Achievements count distinct regions,
distilleries and cask types met, never quantity.

User-generated content: notes shared with friends/public and comments can be reported
and blocked; reports reach a moderation queue with a 72-hour target. Policy: /terms.

Account deletion: Settings → Your data → Delete account, or {{DOMAIN}}/delete-account.
```

Do not list push notifications until the push transport (D4) is live.

## Play — App access

"All or some functionality is restricted" → provide `{{REVIEWER_ACCESS}}` instructions
(same account as Apple). Pending owner decision D4 — Play reviewers cannot use Google
sign-in with a test Google account reliably, so this is a blocker for both stores.

## Export compliance (Apple)

`ITSAppUsesNonExemptEncryption = false` is set in `ios/App/App/Info.plist`: the app uses
only standard HTTPS/TLS provided by the OS. No annual self-classification report needed.

## Sign in with Apple — configuration checklist (owner, when accounts exist)

1. App ID `{{BUNDLE_ID}}` → enable **Sign in with Apple** capability (the entitlement
   is already in `App.entitlements`; a signed build fails to provision until this is on).
2. Production env: `APPLE_APP_BUNDLE_IDENTIFIER={{BUNDLE_ID}}` (native path).
3. Optional web flow: Services ID + key → `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET`
   (signed JWT, rotate ≤ 6 months), return URL `https://{{DOMAIN}}/api/auth/callback/apple`.
4. Apple **server-to-server notifications** endpoint (account deletion / consent revoked)
   is not implemented — not required for review, recommended before launch.
5. Apple requires a way to delete the account in-app (5.1.1(v)) — shipped.

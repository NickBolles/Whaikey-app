"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { applyStatusBarStyle, configureKeyboard, hideSplash } from "@/lib/native/app-chrome";
import { exitApp, onBackButton, onDeepLink, onResume } from "@/lib/native/app-lifecycle";
import {
  clearPendingSignIn,
  closeNativeSignIn,
  describeNativeAuthError,
  exchangeUrl,
  parseAuthCallback,
  readPendingSignIn,
  statesMatch,
} from "@/lib/native/auth";
import type { AuthCallback } from "@/lib/native/auth";
import { checkShellVersion, type ShellVersionCheck } from "@/lib/native/manifest";
import { ShellUpdateRequired } from "@/components/shell-update-required";
import { isNativeApp } from "@/lib/native/platform";
import { refreshPushRegistration } from "@/lib/native/push";
import { flushPourQueue, isOnline } from "@/lib/native/offline-queue";

/**
 * Boots the native shell (docs/NATIVE_APP.md §2.1). Rendered once from the root
 * layout and renders nothing. The native plugin wiring short-circuits on the
 * web; the offline pour flush does not, because web and PWA users queue pours
 * too and something has to send them.
 */
/**
 * How long the splash waits on the version check before showing the app
 * anyway. Long enough for a manifest on a slow connection, short enough that a
 * hanging one is not its own outage.
 */
const SPLASH_CHECK_TIMEOUT_MS = 3_000;

export function NativeShell({ userId }: { userId?: string | null }) {
  const router = useRouter();
  const [outdated, setOutdated] = useState<ShellVersionCheck | null>(null);

  /**
   * Both directions. A floor raised by mistake and then lowered again — which
   * is the likely shape of an operator recovering from an outage — has to lift
   * the gate too, or the app stays behind it until somebody kills the process.
   */
  const applyShellCheck = useCallback((check: ShellVersionCheck) => {
    setOutdated(check.status === "update_required" ? check : null);
  }, []);

  /**
   * Drain any pours logged while offline. Refreshing afterwards is what makes
   * them appear in My Bar and history without the user doing anything.
   */
  const syncQueue = useCallback(async () => {
    if (!isOnline()) return;
    // Scoped to whoever is signed in: on the web the queue is per origin, not
    // per session, so a pour queued by one person must not be sent while
    // someone else is signed in on the same browser.
    const { synced, discarded, unclaimed } = await flushPourQueue(userId ?? undefined);
    if (synced > 0) router.refresh();
    // Neither of these can be shown yet — there is no app-level toast until
    // WP-6 — but neither is lost either: a rejected pour is quarantined rather
    // than deleted, and an unclaimed one stays queued. Logged so the gap is
    // visible in a session replay rather than only in this comment.
    if (discarded.length > 0) {
      console.warn(
        `[pours] ${discarded.length} queued pour(s) the server kept rejecting are in quarantine, awaiting a recovery surface`,
      );
    }
    if (unclaimed > 0) {
      console.warn(
        `[pours] ${unclaimed} queued pour(s) predate author tracking and cannot be attributed; held for their author`,
      );
    }
  }, [router, userId]);

  /**
   * Every platform, not just the device. A PWA on a phone hits the same dead
   * spot as the native app and queues the same way; when the flush lived
   * behind `isNativeApp()` those pours were written to storage, reported as
   * "saved on your phone", and never sent (REL-4.1). The native shell adds a
   * resume hook below — that's a lifecycle the browser doesn't have, not a
   * different sync policy.
   */
  useEffect(() => {
    const onOnline = () => void syncQueue();
    const onVisible = () => {
      // The web's nearest thing to app resume: a tab coming back to the
      // foreground is the moment to catch a network that returned quietly.
      if (document.visibilityState === "visible") void syncQueue();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    void syncQueue();
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [syncQueue]);

  useEffect(() => {
    if (!isNativeApp()) return;

    // Lets CSS target the native shell (safe-area padding, camera transparency)
    // without every component having to know which platform it's on.
    document.documentElement.classList.add("native-app");

    void applyStatusBarStyle();
    void configureKeyboard();

    /**
     * Is this binary new enough for the site it just loaded
     * (docs/NATIVE_APP.md §2.2)? The shell renders whatever the deploy sends,
     * so the web half can move ahead of the app in someone's pocket with
     * nothing to stop it — and a raised floor is the only kill switch there is
     * for a deploy gone wrong, since this is not a store binary you can roll
     * back. Fails open: an unreachable manifest leaves the app running.
     *
     * The splash stays up until this settles. Dropping it first would reveal
     * the newly deployed UI — and run its effects — before we know the binary
     * can render it, which is the failure the gate exists to prevent. Bounded,
     * because a splash that waits forever on a slow manifest is its own
     * outage.
     */
    void Promise.race([
      checkShellVersion(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SPLASH_CHECK_TIMEOUT_MS)),
    ])
      .then((check) => {
        if (check) applyShellCheck(check);
      })
      .finally(() => {
        void hideSplash();
      });

    const unsubscribeBack = onBackButton((canGoBack) => {
      // At the root of the history stack, backing out of the app is what Android
      // users expect; anywhere else it would strand them on a blank WebView.
      if (canGoBack) router.back();
      else void exitApp();
    });

    const unsubscribeDeepLink = onDeepLink((path, rawUrl) => {
      const callback = parseAuthCallback(rawUrl);
      if (callback) {
        // Nothing in here may reject unhandled: the callback arrives once, so a
        // storage read that fails would leave sign-in on "Connecting…" until
        // the code expired, with no error anyone could act on.
        void handleAuthCallback(callback).catch((err: unknown) => {
          console.warn("[native] could not handle the sign-in callback", err);
          void closeNativeSignIn();
          router.push(`/sign-in?error=${encodeURIComponent("Sign-in didn't complete. Please try again.")}`);
        });
        return;
      }
      router.push(path);
    });

    /**
     * `whaikey://` is a scheme any app on the device can register, so an
     * inbound auth callback is a claim, not a fact. Acting on an unsolicited
     * one would swap the WebView into whoever sent it (SEC-H1) — silently, and
     * every pour logged afterwards would land in their account.
     *
     * So: act only on a callback whose state matches the sign-in this app
     * started. Anything else is dropped without a word, because there is no
     * user here to warn; nobody asked for this link.
     *
     * The pending sign-in is read but not consumed until it matches. Clearing
     * it on the way past would let anyone who can launch `whaikey://` cancel a
     * real sign-in with one forged callback.
     */
    async function handleAuthCallback(callback: NonNullable<AuthCallback>): Promise<void> {
      const pending = await readPendingSignIn();
      if (!pending || !statesMatch(pending.state, callback.state)) return;
      // Cleanup must not be able to cost the user their sign-in: the callback
      // arrives once, so a rejected `remove()` here would strand them on
      // "Connecting…" while the code quietly expired. Single use is enforced by
      // the server anyway — this is tidying, not a guard.
      await clearPendingSignIn().catch((err: unknown) => {
        console.warn("[native] could not clear the pending sign-in", err);
      });

      void closeNativeSignIn();
      if ("code" in callback) {
        // A full navigation, not router.push: the point of this request is the
        // Set-Cookie it comes back with, and that only lands in the WebView's
        // cookie store if the WebView itself made the request.
        window.location.assign(exchangeUrl(callback.code, pending.verifier, callback.next));
      } else {
        const message = describeNativeAuthError(callback.error);
        const retry = new URLSearchParams({ error: message ?? "Sign-in failed." });
        // Keep the return target on the retry, so trying again still lands
        // on the scanned page (the sign-in page re-validates it).
        if (callback.next) retry.set("next", callback.next);
        router.push(`/sign-in?${retry.toString()}`);
      }
    }

    /**
     * Tell the server this device is still here (review SEC-M6). A push token
     * stays with its account until that account releases it or stops
     * refreshing it, and nothing was refreshing it — every registration aged
     * into "abandoned" after a week and became claimable by anyone holding the
     * leaked token. Never prompts: a device that has not opted in is left
     * alone.
     */
    void refreshPushRegistration();

    const unsubscribeResume = onResume(() => {
      /**
       * The floor first, and only then the refresh.
       *
       * The WebView survives backgrounding, so the app most likely to be awake
       * across a bad deploy is exactly this one — and refreshing before
       * asking would fetch and render the newly deployed payload, effects and
       * all, which is the failure the gate exists to prevent. A floor raised
       * while the app was away therefore takes effect on the next foreground,
       * not the next cold launch.
       */
      void checkShellVersion().then((check) => {
        applyShellCheck(check);
        if (check.status === "update_required") return;

        // Server-rendered pages (My Bar totals, pour history) go stale while
        // the app is backgrounded; refresh re-runs them without losing client
        // state.
        router.refresh();
        // Coming back to the app is the most reliable moment to catch a
        // network that returned while we weren't looking. A backgrounded
        // WebView doesn't reliably fire `visibilitychange`, so this is its own
        // hook rather than a duplicate of the web one above.
        void syncQueue();
        void refreshPushRegistration();
      });
    });

    return () => {
      unsubscribeBack();
      unsubscribeDeepLink();
      unsubscribeResume();
      document.documentElement.classList.remove("native-app");
    };
  }, [applyShellCheck, router, syncQueue]);

  if (!outdated) return null;

  return (
    <ShellUpdateRequired
      notice={outdated.notice}
      storeUrl={outdated.storeUrl}
      installed={outdated.installed}
      required={outdated.required}
    />
  );
}

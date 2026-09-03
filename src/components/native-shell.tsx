"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { applyStatusBarStyle, configureKeyboard, hideSplash } from "@/lib/native/app-chrome";
import { exitApp, onBackButton, onDeepLink, onResume } from "@/lib/native/app-lifecycle";
import {
  closeNativeSignIn,
  describeNativeAuthError,
  exchangeUrl,
  parseAuthCallback,
  statesMatch,
  takePendingSignIn,
} from "@/lib/native/auth";
import type { AuthCallback } from "@/lib/native/auth";
import { isNativeApp } from "@/lib/native/platform";
import { flushPourQueue, isOnline } from "@/lib/native/offline-queue";

/**
 * Boots the native shell (docs/NATIVE_APP.md §2.1). Rendered once from the root
 * layout and renders nothing. The native plugin wiring short-circuits on the
 * web; the offline pour flush does not, because web and PWA users queue pours
 * too and something has to send them.
 */
export function NativeShell() {
  const router = useRouter();

  /**
   * Drain any pours logged while offline. Refreshing afterwards is what makes
   * them appear in My Bar and history without the user doing anything.
   */
  const syncQueue = useCallback(async () => {
    if (!isOnline()) return;
    const { synced } = await flushPourQueue();
    if (synced > 0) router.refresh();
  }, [router]);

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
    // The app has painted by the time this effect runs — that's the cue to drop
    // the splash, rather than the config's blunt timeout.
    void hideSplash();

    const unsubscribeBack = onBackButton((canGoBack) => {
      // At the root of the history stack, backing out of the app is what Android
      // users expect; anywhere else it would strand them on a blank WebView.
      if (canGoBack) router.back();
      else void exitApp();
    });

    const unsubscribeDeepLink = onDeepLink((path, rawUrl) => {
      const callback = parseAuthCallback(rawUrl);
      if (callback) {
        void handleAuthCallback(callback);
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
     * So: take the sign-in this app started (once — the read clears it), and
     * act only on a callback whose state matches it. Anything else is dropped
     * without a word, because there is no user here to warn; nobody asked for
     * this link.
     */
    async function handleAuthCallback(callback: NonNullable<AuthCallback>): Promise<void> {
      const pending = await takePendingSignIn();
      if (!pending || !statesMatch(pending.state, callback.state)) return;

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

    const unsubscribeResume = onResume(() => {
      // Server-rendered pages (My Bar totals, pour history) go stale while the
      // app is backgrounded; refresh re-runs them without losing client state.
      router.refresh();
      // Coming back to the app is the most reliable moment to catch a network
      // that returned while we weren't looking. A backgrounded WebView doesn't
      // reliably fire `visibilitychange`, so this is its own hook rather than
      // a duplicate of the web one above.
      void syncQueue();
    });

    return () => {
      unsubscribeBack();
      unsubscribeDeepLink();
      unsubscribeResume();
      document.documentElement.classList.remove("native-app");
    };
  }, [router, syncQueue]);

  return null;
}

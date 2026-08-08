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
} from "@/lib/native/auth";
import { isNativeApp } from "@/lib/native/platform";
import { flushPourQueue, isOnline } from "@/lib/native/offline-queue";

/**
 * Boots the native shell (docs/NATIVE_APP.md §2.1). Rendered once from the root
 * layout, renders nothing, and short-circuits entirely on the web — so the web
 * app pays a mounted-effect and nothing else.
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
        void closeNativeSignIn();
        if ("code" in callback) {
          // A full navigation, not router.push: the point of this request is the
          // Set-Cookie it comes back with, and that only lands in the WebView's
          // cookie store if the WebView itself made the request.
          window.location.assign(exchangeUrl(callback.code));
        } else {
          const message = describeNativeAuthError(callback.error);
          router.push(`/sign-in?error=${encodeURIComponent(message ?? "Sign-in failed.")}`);
        }
        return;
      }
      router.push(path);
    });

    const unsubscribeResume = onResume(() => {
      // Server-rendered pages (My Bar totals, pour history) go stale while the
      // app is backgrounded; refresh re-runs them without losing client state.
      router.refresh();
      // Coming back to the app is the most reliable moment to catch a network
      // that returned while we weren't looking.
      void syncQueue();
    });

    // Flush on reconnect as well, so a pour goes up the moment signal returns
    // rather than waiting for the user to background and reopen the app.
    const onOnline = () => void syncQueue();
    window.addEventListener("online", onOnline);
    void syncQueue();

    return () => {
      unsubscribeBack();
      unsubscribeDeepLink();
      unsubscribeResume();
      window.removeEventListener("online", onOnline);
      document.documentElement.classList.remove("native-app");
    };
  }, [router, syncQueue]);

  return null;
}

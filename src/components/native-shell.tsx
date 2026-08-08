"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { applyStatusBarStyle, configureKeyboard, hideSplash } from "@/lib/native/app-chrome";
import { exitApp, onBackButton, onDeepLink, onResume } from "@/lib/native/app-lifecycle";
import { isNativeApp } from "@/lib/native/platform";

/**
 * Boots the native shell (docs/NATIVE_APP.md §2.1). Rendered once from the root
 * layout, renders nothing, and short-circuits entirely on the web — so the web
 * app pays a mounted-effect and nothing else.
 */
export function NativeShell() {
  const router = useRouter();

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

    const unsubscribeDeepLink = onDeepLink((path) => {
      router.push(path);
    });

    const unsubscribeResume = onResume(() => {
      // Server-rendered pages (My Bar totals, pour history) go stale while the
      // app is backgrounded; refresh re-runs them without losing client state.
      router.refresh();
    });

    return () => {
      unsubscribeBack();
      unsubscribeDeepLink();
      unsubscribeResume();
      document.documentElement.classList.remove("native-app");
    };
  }, [router]);

  return null;
}

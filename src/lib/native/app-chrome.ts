/**
 * Native chrome: the status bar, splash screen, and keyboard behaviour that
 * separate "an app" from "a website in a box" (docs/NATIVE_APP.md §3.1).
 *
 * Every call is fire-and-forget polish — `nativeOnly` swallows failures so a
 * missing plugin can never break a render.
 */
import { isAndroid, isIos, nativeOnly } from "./platform";

/** Whaikey's page background — the status bar has to match it exactly. */
const BACKGROUND = "#14100b";

/**
 * Tint the status bar to match the app background.
 *
 * `Style.Dark` is Capacitor's name for *light content on a dark background*,
 * which is what a #14100b app wants. The Android background colour is a no-op on
 * iOS, where the status bar is always drawn over the app.
 */
export async function applyStatusBarStyle(): Promise<void> {
  await nativeOnly(async () => {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
    if (isAndroid()) {
      await StatusBar.setBackgroundColor({ color: BACKGROUND });
      // The layout handles insets via env(safe-area-inset-*); letting the status
      // bar overlay the WebView on top of that would double-count the offset.
      await StatusBar.setOverlaysWebView({ overlay: false });
    }
  });
}

/** Dismiss the launch splash once the app has actually painted. */
export async function hideSplash(): Promise<void> {
  await nativeOnly(async () => {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  });
}

/**
 * Stop iOS from scrolling the whole WebView up when the keyboard appears —
 * with `resize: "native"` the viewport is resized instead, which keeps sticky
 * elements (the bottom nav) where they belong.
 */
export async function configureKeyboard(): Promise<void> {
  if (!isIos()) return;
  await nativeOnly(async () => {
    const { Keyboard } = await import("@capacitor/keyboard");
    await Keyboard.setScroll({ isDisabled: true });
  });
}

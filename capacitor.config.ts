import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

/**
 * Native shell configuration — see docs/NATIVE_APP.md §2.2.
 *
 * The WebView loads the deployed Next.js app over HTTPS rather than a bundled
 * static export, so server components, first-party session cookies, and instant
 * UI updates all keep working unchanged. `native/shell` still ships inside the
 * binary and serves as `errorPath`: the offline/unreachable fallback screen.
 *
 * Without a server URL the app boots straight into that shell, which explains
 * how to configure one — `pnpm native:check` fails a release build in that state.
 */
const serverUrl = process.env.CAP_SERVER_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";

const config: CapacitorConfig = {
  appId: "com.whaikey.app",
  appName: "Whaikey",
  webDir: "native/shell",
  ...(serverUrl
    ? {
        server: {
          url: serverUrl,
          // https://localhost on Android keeps the WebView on a secure origin, so
          // getUserMedia and the session cookie behave as they do on the web.
          androidScheme: "https",
          errorPath: "index.html",
        },
      }
    : {}),
  ios: {
    // Never let WKWebView guess at insets — the layout handles notch and home
    // indicator through `env(safe-area-inset-*)` (see globals.css).
    contentInset: "never",
    backgroundColor: "#14100b",
  },
  android: {
    backgroundColor: "#14100b",
  },
  plugins: {
    SplashScreen: {
      backgroundColor: "#14100b",
      showSpinner: false,
      // NativeShell hides the splash as soon as the app paints; this is only the
      // backstop for a WebView that never gets far enough to run that code.
      launchAutoHide: true,
      launchShowDuration: 3000,
      launchFadeOutDuration: 200,
      androidScaleType: "CENTER_CROP",
    },
    StatusBar: {
      // "DARK" means light content — the app background is #14100b.
      style: "DARK",
      backgroundColor: "#14100b",
      overlaysWebView: false,
    },
    Keyboard: {
      // Resize the WebView itself rather than scrolling it, so the sticky bottom
      // nav stays put when the keyboard opens.
      resize: KeyboardResize.Native,
    },
  },
};

export default config;

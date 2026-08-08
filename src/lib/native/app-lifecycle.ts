/**
 * App lifecycle: Android's hardware back button, deep links, and
 * foreground/background transitions (docs/NATIVE_APP.md §3.1).
 *
 * Each registration returns an unsubscribe function that is safe to call even
 * when nothing was registered (web, SSR, missing plugin), so `useEffect`
 * cleanups stay unconditional.
 */
import { loadPlugin } from "./platform";

export type Unsubscribe = () => void;

/** Hosts whose https:// links belong to this app (Universal Links / App Links). */
const APP_HOSTS = new Set(
  [process.env.NEXT_PUBLIC_APP_URL]
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      try {
        return new URL(value).host;
      } catch {
        return "";
      }
    })
    .filter(Boolean),
);

/**
 * Turn a deep link into an in-app path, or null if it isn't ours.
 *
 * Handles both link shapes: the custom scheme (`whaikey://bottles/123`), where
 * the "host" is really the first path segment, and Universal/App Links
 * (`https://app.whaikey.com/bottles/123`), which must match a known host so a
 * link to someone else's site never navigates the app.
 *
 * Exported separately from the listener because URL mapping is the part worth
 * testing, and it needs no plugin to do it.
 */
export function deepLinkPath(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol === "whaikey:") {
    // new URL("whaikey://bottles/123") parses "bottles" as the host.
    const path = `/${url.host}${url.pathname}`.replace(/\/{2,}/g, "/");
    return `${path === "/" ? "/" : path.replace(/\/$/, "")}${url.search}`;
  }

  if ((url.protocol === "https:" || url.protocol === "http:") && APP_HOSTS.has(url.host)) {
    return `${url.pathname}${url.search}`;
  }

  return null;
}

/**
 * Handle Android's hardware back button.
 *
 * Without this the button closes the app from anywhere, which reads as a crash.
 * `canGoBack` is Capacitor's view of WebView history; at the root of it, backing
 * out of the app is the correct Android behaviour.
 */
export function onBackButton(handler: (canGoBack: boolean) => void): Unsubscribe {
  return listen(async () => {
    const plugin = await loadPlugin(() => import("@capacitor/app"));
    if (!plugin) return null;
    return plugin.App.addListener("backButton", ({ canGoBack }) => handler(canGoBack));
  });
}

/** Fires when a deep link opens the app, with the resolved in-app path. */
export function onDeepLink(handler: (path: string) => void): Unsubscribe {
  return listen(async () => {
    const plugin = await loadPlugin(() => import("@capacitor/app"));
    if (!plugin) return null;
    return plugin.App.addListener("appUrlOpen", ({ url }) => {
      const path = deepLinkPath(url);
      if (path) handler(path);
    });
  });
}

/** Fires when the app returns to the foreground — the cue to refresh stale data. */
export function onResume(handler: () => void): Unsubscribe {
  return listen(async () => {
    const plugin = await loadPlugin(() => import("@capacitor/app"));
    if (!plugin) return null;
    return plugin.App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) handler();
    });
  });
}

/** Close the app. Android only in practice — iOS forbids programmatic exit. */
export async function exitApp(): Promise<void> {
  const plugin = await loadPlugin(() => import("@capacitor/app"));
  await plugin?.App.exitApp().catch(() => {});
}

/**
 * Bridge Capacitor's async listener registration to a synchronous unsubscribe.
 * If the caller unsubscribes before registration resolves, the handle is removed
 * as soon as it arrives rather than leaking.
 */
function listen(register: () => Promise<{ remove: () => Promise<void> } | null>): Unsubscribe {
  let cancelled = false;
  let handle: { remove: () => Promise<void> } | null = null;

  void register()
    .then((result) => {
      handle = result;
      if (cancelled) void handle?.remove().catch(() => {});
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    void handle?.remove().catch(() => {});
  };
}

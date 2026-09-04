import { loadPlugin } from "./platform";

/**
 * The shell's version check (docs/NATIVE_APP.md §2.2, review WP-20).
 *
 * The WebView loads the deployed site, so the web half of the app can move
 * ahead of the binary in someone's pocket and there is nothing to stop it —
 * a deploy that needs a plugin the installed shell doesn't have renders a
 * broken screen with no explanation. This asks the server what it needs and
 * compares it against what is installed.
 *
 * Fails **open**, deliberately: an unreachable or unparseable manifest leaves
 * the app running. A version check that locks people out when the network
 * hiccups is a worse outage than the one it prevents.
 */

export interface ShellVersionCheck {
  status: "ok" | "update_required" | "unknown";
  installed: string | null;
  required: string | null;
  notice: string | null;
  storeUrl: string | null;
}

interface ManifestResponse {
  minShellVersion?: unknown;
  notice?: unknown;
  storeUrl?: { ios?: unknown; android?: unknown };
}

/** -1, 0, 1 for `a` against `b`; missing parts count as zero. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part) || 0);
  const right = b.split(".").map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** The installed binary's version, or null off-device. */
export async function installedShellVersion(): Promise<string | null> {
  const plugin = await loadPlugin(() => import("@capacitor/app"));
  if (!plugin) return null;
  try {
    const info = await plugin.App.getInfo();
    return info.version || null;
  } catch {
    return null;
  }
}

export async function checkShellVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<ShellVersionCheck> {
  const unknown: ShellVersionCheck = {
    status: "unknown",
    installed: null,
    required: null,
    notice: null,
    storeUrl: null,
  };

  const installed = await installedShellVersion();
  if (!installed) return unknown;

  let manifest: ManifestResponse;
  try {
    const res = await fetchImpl("/api/native/manifest", { cache: "no-store" });
    if (!res.ok) return { ...unknown, installed };
    manifest = (await res.json()) as ManifestResponse;
  } catch {
    return { ...unknown, installed };
  }

  const required =
    typeof manifest.minShellVersion === "string" &&
    /^\d+\.\d+\.\d+$/.test(manifest.minShellVersion)
      ? manifest.minShellVersion
      : null;
  if (!required) return { ...unknown, installed };

  const { isIos } = await import("./platform");
  const store = manifest.storeUrl ?? {};
  const rawStoreUrl = isIos() ? store.ios : store.android;

  return {
    status: compareVersions(installed, required) < 0 ? "update_required" : "ok",
    installed,
    required,
    notice: typeof manifest.notice === "string" && manifest.notice ? manifest.notice : null,
    storeUrl: typeof rawStoreUrl === "string" && rawStoreUrl ? rawStoreUrl : null,
  };
}

import { NextResponse } from "next/server";
import { reportingErrors } from "@/lib/observability/errors";

export const dynamic = "force-dynamic";

/**
 * What the native shell has to be for this deploy (docs/NATIVE_APP.md §2.2).
 *
 * The shell loads the deployed site over HTTPS, which is why a UI change ships
 * without store review — and is also why **a bad deploy bricks every installed
 * app**, with nothing to pin a version against. This is the missing floor: the
 * shell reads it at boot and, if the site now needs a newer binary than the one
 * installed, shows "Update Whaikey" instead of a UI it cannot run.
 *
 * It doubles as the kill switch the doc asks for. Raising
 * `WHAIKEY_MIN_SHELL_VERSION` above every released build stops the installed
 * app dead behind an update screen, which is the only lever available when a
 * deploy has gone wrong and the app is not a store binary you can roll back.
 *
 * Public and unauthenticated by necessity: the shell asks before anybody has
 * signed in, and the answer is the same for everyone. It says nothing a store
 * listing does not already say.
 */

/** No floor unless one is configured — a fresh deploy locks nobody out. */
const DEFAULT_MIN_SHELL_VERSION = "0.0.0";

export interface NativeManifest {
  /** Lowest shell version this deploy supports, as `major.minor.patch`. */
  minShellVersion: string;
  /** Optional line shown on the update screen, for a specific outage. */
  notice: string | null;
  /** Where to send someone whose app is too old. */
  storeUrl: { ios: string | null; android: string | null };
}

/** `1.2.3`, and nothing else — a floor that fails to parse is not a floor. */
function validVersion(value: string | undefined): string | null {
  return value && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

async function handleGet(): Promise<NextResponse> {
  const configured = validVersion(process.env.WHAIKEY_MIN_SHELL_VERSION);
  if (process.env.WHAIKEY_MIN_SHELL_VERSION && !configured) {
    // Loud, because a typo here silently removes the floor rather than
    // breaking anything a test would catch.
    console.error(
      "[native] WHAIKEY_MIN_SHELL_VERSION is not major.minor.patch; no version floor is in effect",
    );
  }

  const manifest: NativeManifest = {
    minShellVersion: configured ?? DEFAULT_MIN_SHELL_VERSION,
    notice: process.env.WHAIKEY_SHELL_NOTICE?.trim() || null,
    storeUrl: {
      ios: process.env.NEXT_PUBLIC_IOS_STORE_URL?.trim() || null,
      android: process.env.NEXT_PUBLIC_ANDROID_STORE_URL?.trim() || null,
    },
  };

  return NextResponse.json(manifest, {
    // Short and shared: the point of a kill switch is that it takes effect in
    // minutes, and the point of caching it at all is that every app launch
    // asks. Sixty seconds is both.
    headers: { "cache-control": "public, max-age=60" },
  });
}

/**
 * Reporting only (WP-19). This route does not use `withErrorHandling` — it
 * owns its own responses for reasons documented above — so the wrapper adds
 * the Sentry report and nothing else: same error, same response, same status.
 */
export async function GET(): Promise<NextResponse> {
  return reportingErrors("native/manifest", () => handleGet());
}

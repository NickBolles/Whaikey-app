/**
 * Sharing (docs/NATIVE_APP.md §3.2) — the native share sheet on a device, the
 * Web Share API in a supporting browser, clipboard everywhere else.
 */
import { loadPlugin } from "./platform";

export interface ShareRequest {
  title: string;
  text?: string;
  url?: string;
  /** iOS only: title of the share-sheet dialog. */
  dialogTitle?: string;
}

export type ShareOutcome = "shared" | "copied" | "unavailable";

/**
 * Share content, returning how it was handled so the caller can confirm to the
 * user ("Copied link" vs. saying nothing after a native sheet). A user
 * cancelling the sheet resolves as "shared" — it isn't a failure.
 */
export async function share(request: ShareRequest): Promise<ShareOutcome> {
  const plugin = await loadPlugin(() => import("@capacitor/share"));
  if (plugin) {
    try {
      await plugin.Share.share(request);
      return "shared";
    } catch {
      // Cancelling the sheet rejects on both platforms; fall through to copy.
    }
  }

  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share({ title: request.title, text: request.text, url: request.url });
      return "shared";
    } catch {
      // Cancelled, or blocked outside a user gesture.
    }
  }

  const fallbackText = [request.text, request.url].filter(Boolean).join("\n");
  if (fallbackText && typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(fallbackText);
      return "copied";
    } catch {
      // Clipboard permission denied.
    }
  }

  return "unavailable";
}

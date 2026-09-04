import type { Metadata } from "next";
import { ShellUpdateRequired } from "@/components/shell-update-required";

export const metadata: Metadata = { title: "Update Whaikey" };

/**
 * The update gate as a page (docs/STORYBOARD.md §3.15).
 *
 * The native shell renders this same component inline when the installed
 * binary is below the deploy's floor, passing the versions it actually found.
 * Having it at a route as well is what makes an outage-critical screen
 * reviewable — the visual suite can screenshot it — and gives a store listing
 * or a support reply somewhere to point.
 *
 * No version numbers here: this page has no installed binary to report, and
 * inventing a pair for the sake of a fuller screenshot would put two false
 * numbers on a page anyone can reach. The store links are the real configured
 * ones, so this shows exactly what a device would see.
 */
export default function AppUpdatePage() {
  return (
    <ShellUpdateRequired
      // Both, when both are configured. This page can be opened from anywhere
      // — a support reply, a store listing — and it has no platform to infer
      // one from, so picking the first would send every Android visitor to the
      // App Store. The shell, which does know, passes a single one.
      storeUrl={process.env.NEXT_PUBLIC_IOS_STORE_URL?.trim() || null}
      androidStoreUrl={process.env.NEXT_PUBLIC_ANDROID_STORE_URL?.trim() || null}
    />
  );
}

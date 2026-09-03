import type { Metadata } from "next";
import { ShellUpdateRequired } from "@/components/shell-update-required";

export const metadata: Metadata = { title: "Update Whaikey" };

/**
 * The update gate as a page (docs/STORYBOARD.md §3.15).
 *
 * The native shell renders this same component inline when the installed
 * binary is below the deploy's floor. Having it at a route as well is what
 * makes an outage-critical screen reviewable: the visual suite can screenshot
 * it, and it can be linked to from a store listing or a support reply. It
 * asserts nothing about the visitor — a browser that lands here is simply told
 * to update the app, which is true of nobody and harmful to no one.
 */
export default function AppUpdatePage() {
  return <ShellUpdateRequired installed="1.2.0" required="1.4.0" />;
}

"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  isFreshDocumentLoad,
  markPopNavigation,
  recordNavigation,
  resetNavigation,
} from "@/lib/nav-history";

/**
 * Feeds the header's back button (src/lib/nav-history.ts). Rendered once from
 * the root layout — above the header, which unmounts on chromeless routes and
 * would otherwise miss the pages visited there. Renders nothing.
 */
export function NavHistoryTracker() {
  const pathname = usePathname();
  const firstRun = useRef(true);

  useEffect(() => {
    // Registered once. Next's router listens for the same event and changes
    // the pathname in response, so this flag is always set before the effect
    // below sees the new path.
    const onPop = () => markPopNavigation();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      if (isFreshDocumentLoad()) {
        resetNavigation(pathname);
        return;
      }
    }
    recordNavigation(pathname);
  }, [pathname]);

  return null;
}

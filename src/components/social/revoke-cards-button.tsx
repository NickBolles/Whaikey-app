"use client";

import { useState } from "react";

/** Settings → Shared links: kill every share-card link at once (they can't be listed one by one — they hold no state). */
export function RevokeCardsButton() {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button
        type="button"
        disabled={state === "busy"}
        onClick={async () => {
          if (!window.confirm("Stop every share card you've shared from opening? This can't be undone.")) return;
          setState("busy");
          const res = await fetch("/api/cards/revoke", { method: "POST" }).catch(() => null);
          setState(res?.ok ? "done" : "error");
        }}
        className="btn-secondary tap-target px-3 py-1.5 text-sm disabled:opacity-60"
      >
        Revoke all share cards
      </button>
      {state === "done" && <span role="status" className="text-xs text-muted">Done — old card links no longer open.</span>}
      {state === "error" && <span role="status" className="text-xs text-muted">Couldn&rsquo;t reach the server — try again.</span>}
    </div>
  );
}

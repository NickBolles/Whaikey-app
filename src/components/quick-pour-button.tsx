"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GlassWater } from "lucide-react";

/**
 * One tap, one dram: logs a pour of the bottle with zero notes and zero
 * score — the record can always be enriched later from the journal.
 */
export function QuickPourButton({ bottleId, bottleName }: { bottleId: string; bottleName: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">("idle");

  async function pour() {
    setState("saving");
    const res = await fetch("/api/pours", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bottleId }),
    }).catch(() => null);
    if (!res?.ok) {
      setState("error");
      setTimeout(() => setState("idle"), 3000);
      return;
    }
    setState("done");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={pour}
      disabled={state === "saving" || state === "done"}
      aria-label={`Log a pour of ${bottleName}`}
      className={`tap-target inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-border-subtle px-3 text-xs font-medium transition-colors ${
        state === "done" ? "text-accent border-accent/55" : "text-muted hover:text-foreground"
      }`}
      data-testid="quick-pour"
    >
      <GlassWater size={14} strokeWidth={1.8} aria-hidden />
      {state === "done" ? "Poured ✓" : state === "saving" ? "Pouring…" : state === "error" ? "Retry" : "Pour"}
    </button>
  );
}

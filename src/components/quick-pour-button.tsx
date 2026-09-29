"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GlassWater } from "lucide-react";
import { useToast } from "@/components/toast";

/**
 * One tap, one dram: logs a pour of the bottle with zero notes and zero
 * score — the record can always be enriched later from the journal.
 *
 * One tap is also one mis-tap, so it confirms with the app toast and its Undo
 * (docs/STORYBOARD.md §1.2: "log a pour" is the first reversible mutation on
 * that list). Undo deletes the pour it just made.
 */
export function QuickPourButton({ bottleId, bottleName }: { bottleId: string; bottleName: string }) {
  const router = useRouter();
  const toast = useToast();
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
      toast.error(`Couldn't log a pour of ${bottleName}. Try again.`);
      setTimeout(() => setState("idle"), 3000);
      return;
    }
    const pourId = await res
      .json()
      .then((body: { pour?: { id?: unknown } }) => (typeof body.pour?.id === "string" ? body.pour.id : null))
      .catch(() => null);
    setState("done");
    router.refresh();
    toast.show({
      message: `Poured ${bottleName}`,
      tone: "success",
      // No id back means nothing to aim a delete at; the pour stands, and the
      // journal is where it can be removed.
      undo: pourId
        ? async () => {
            const undone = await fetch(`/api/pours/${encodeURIComponent(pourId)}`, { method: "DELETE" });
            if (!undone.ok) throw new Error(`DELETE /api/pours/${pourId} → ${undone.status}`);
            setState("idle");
            router.refresh();
          }
        : undefined,
    });
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

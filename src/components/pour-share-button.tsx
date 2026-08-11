"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import { share } from "@/lib/native/share";

export function PourShareButton({ pourId, bottleName }: { pourId: string; bottleName: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleShare() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/pours/${pourId}/share`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { path?: string; error?: string } | null;
      if (!res.ok || !body?.path) throw new Error(body?.error ?? "Couldn’t create a share link.");
      const url = new URL(body.path, window.location.origin).toString();
      const outcome = await share({
        title: `My ${bottleName} pour`,
        text: "A tasting note from Whaikey.",
        url,
        dialogTitle: "Share tasting note",
      });
      setStatus(outcome === "copied" ? "Link copied" : outcome === "shared" ? "Ready to share" : "Link created");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn’t create a share link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleShare}
        disabled={busy}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border-subtle px-3 text-sm text-muted transition-colors hover:border-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
        aria-label={`Share ${bottleName} tasting note`}
      >
        <Share2 size={16} strokeWidth={1.8} aria-hidden />
        {busy ? "Creating…" : "Share"}
      </button>
      {status && <span className="text-xs text-muted" role="status">{status}</span>}
    </div>
  );
}

"use client";

import { useState } from "react";
import { MapPin, Share2 } from "lucide-react";
import { share } from "@/lib/native/share";

export function PourShareButton({ pourId, bottleName }: { pourId: string; bottleName: string }) {
  const [expanded, setExpanded] = useState(false);
  const [locationLabel, setLocationLabel] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleShare() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/pours/${pourId}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ locationLabel: locationLabel.trim() || null }),
      });
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
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex min-h-11 w-fit items-center gap-2 rounded-xl border border-border-subtle px-3 text-sm text-muted transition-colors hover:border-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        aria-expanded={expanded}
      >
        <Share2 size={16} strokeWidth={1.8} aria-hidden /> Share
      </button>
      {expanded && (
        <div className="card-flat flex flex-col gap-3 p-3">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs text-muted"><MapPin size={13} aria-hidden /> Add a location <span className="text-muted/70">(optional)</span></span>
            <input
              value={locationLabel}
              maxLength={80}
              onChange={(event) => setLocationLabel(event.target.value)}
              placeholder="e.g. Back porch"
              className="min-h-11 rounded-xl border border-border-subtle bg-surface px-3 text-sm placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            />
          </label>
          <p className="text-xs leading-relaxed text-muted">Only this label is shared—Whaikey never uses your device location.</p>
          <button type="button" onClick={handleShare} disabled={busy} className="btn-primary min-h-11 px-4 text-sm disabled:opacity-60">
            {busy ? "Creating…" : "Share tasting note"}
          </button>
        </div>
      )}
      {status && <span className="text-xs text-muted" role="status">{status}</span>}
    </div>
  );
}

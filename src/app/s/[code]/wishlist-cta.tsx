"use client";

import { useState } from "react";
import { BookmarkPlus, Check } from "lucide-react";
import type { Relationship } from "@/db/schema";

const RELATIONSHIP_LABEL: Record<Relationship, string> = {
  own: "Already on your shelf",
  tried: "You've already tried this one",
  wishlist: "Already on your wishlist",
};

/** US-3: one-tap wishlist from a share link, for a viewer with no notes on the bottle yet. */
export function WishlistCta({
  bottleId,
  initialRelationship,
}: {
  bottleId: string;
  initialRelationship: Relationship | null;
}) {
  const [relationship, setRelationship] = useState<Relationship | null>(initialRelationship);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    if (busy || relationship) return;
    setBusy(true);
    setError(null);
    try {
      // The page may be stale: if the viewer shelved this bottle elsewhere
      // since it rendered, show that relationship instead of demoting an
      // owned/tried bottle back to a wishlist entry via the upsert.
      const current = await fetch("/api/user-bottles")
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
      const existing = Array.isArray(current)
        ? (current as Array<{ bottleId: string; relationship: Relationship }>).find(
            (row) => row.bottleId === bottleId,
          )
        : null;
      if (existing) {
        setRelationship(existing.relationship);
        return;
      }

      const res = await fetch("/api/user-bottles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bottleId, relationship: "wishlist" }),
      });
      if (!res.ok) throw new Error("Couldn't add that to your wishlist.");
      setRelationship("wishlist");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that to your wishlist.");
    } finally {
      setBusy(false);
    }
  }

  if (relationship) {
    return (
      <div className="card-flat flex items-center gap-2 p-4 text-sm text-muted">
        <Check size={18} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden />
        {RELATIONSHIP_LABEL[relationship]}
      </div>
    );
  }

  return (
    <div className="card-flat flex flex-col gap-3 p-4">
      <p className="text-sm text-muted">Haven&apos;t tried this one yet?</p>
      <button
        type="button"
        onClick={handleAdd}
        disabled={busy}
        className="btn-primary inline-flex w-fit min-h-11 items-center justify-center gap-2 px-4 text-sm disabled:opacity-60"
      >
        <BookmarkPlus size={18} strokeWidth={1.8} aria-hidden /> {busy ? "Adding…" : "Add to wishlist"}
      </button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RELATIONSHIPS, type Relationship } from "@/db/schema";

const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  own: "I own it",
  tried: "I've tried it",
  wishlist: "Wishlist",
};

/**
 * Relationship buttons for the "Your shelf" block. POSTs to /api/user-bottles
 * per the contract: { bottleId, relationship: "own" | "tried" | "wishlist" }
 * upserts the row. (That endpoint is owned by the bar vertical.)
 */
export function ShelfActions({
  bottleId,
  current,
}: {
  bottleId: string;
  current: Relationship | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Relationship | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setRelationship(relationship: Relationship) {
    setPending(relationship);
    setError(null);
    try {
      const res = await fetch("/api/user-bottles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bottleId, relationship }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      router.refresh();
    } catch {
      setError("Couldn't update your shelf. Try again in a moment.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {RELATIONSHIPS.map((r) => {
          const active = current === r;
          return (
            <button
              key={r}
              type="button"
              disabled={pending !== null}
              onClick={() => setRelationship(r)}
              aria-pressed={active}
              className={`flex-1 px-3 py-3 text-sm font-medium disabled:opacity-60 ${
                active ? "btn-primary" : "btn-secondary"
              }`}
            >
              {pending === r ? "Saving…" : RELATIONSHIP_LABELS[r]}
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-xs text-muted">
          {error}
        </p>
      )}
    </div>
  );
}

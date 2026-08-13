"use client";

import { useState } from "react";
import Link from "next/link";
import { Wine } from "lucide-react";

/**
 * One-tap "Cheers" reaction (docs/SOCIAL.md US-9, §7.5): positive-only, no
 * dislike, count renders on the object only — never a person-level score.
 * POST/DELETE /api/social/cheers/[pourId]; optimistic with revert on failure.
 */
export function CheersButton({
  pourId,
  initialCount,
  initialCheered,
  disabled = false,
}: {
  pourId: string;
  initialCount: number;
  initialCheered: boolean;
  /** True for the note's own author — cheering your own note is pointless, so show count only. */
  disabled?: boolean;
}) {
  const [count, setCount] = useState(Math.max(0, initialCount));
  const [cheered, setCheered] = useState(initialCheered);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<"profile_required" | "error" | null>(null);

  if (disabled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted">
        <Wine size={16} strokeWidth={1.8} aria-hidden />
        <span className="tabular-nums">{count}</span> Cheers
      </span>
    );
  }

  async function handleToggle() {
    if (busy) return;
    setBusy(true);
    setHint(null);
    const nextCheered = !cheered;
    const previousCheered = cheered;
    const previousCount = count;
    setCheered(nextCheered);
    setCount((c) => Math.max(0, c + (nextCheered ? 1 : -1)));
    try {
      const res = await fetch(`/api/social/cheers/${pourId}`, { method: nextCheered ? "POST" : "DELETE" });
      if (res.status === 409) {
        setCheered(previousCheered);
        setCount(previousCount);
        setHint("profile_required");
        return;
      }
      if (!res.ok) throw new Error("Couldn't update that.");
      const body = (await res.json().catch(() => null)) as { cheersCount?: number } | null;
      if (body && typeof body.cheersCount === "number") setCount(Math.max(0, body.cheersCount));
    } catch {
      setCheered(previousCheered);
      setCount(previousCount);
      setHint("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={handleToggle}
        disabled={busy}
        aria-pressed={cheered}
        className={`tap-target inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm transition-colors disabled:opacity-60 ${
          cheered
            ? "border-accent/60 bg-accent/10 text-accent"
            : "border-border-subtle text-muted hover:border-accent/40 hover:text-foreground"
        }`}
      >
        <Wine size={16} strokeWidth={1.8} aria-hidden />
        <span className="tabular-nums">{count}</span> Cheers
      </button>
      {hint === "profile_required" && (
        <p className="text-xs text-muted">
          <Link href="/friends" className="text-accent transition-[filter] hover:brightness-110">
            Claim a handle to join in
          </Link>
        </p>
      )}
      {hint === "error" && (
        <p role="alert" className="text-xs text-danger">
          Couldn&apos;t update that.
        </p>
      )}
    </div>
  );
}

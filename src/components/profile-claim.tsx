"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AtSign, Check } from "lucide-react";
import type { SocialProfile } from "@/lib/social";

// Kept in sync with src/lib/social.ts's HANDLE_RE by hand — this component
// never imports src/lib/social.ts at runtime (it pulls in server-only db
// code), so the shape is duplicated deliberately rather than shared.
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/**
 * Reusable handle-claim flow: POST /api/social/profile. Used by /friends
 * (first social action) and available to any other surface that needs to
 * claim a handle before writing (comments, cheers, follows).
 */
export function ProfileClaim({
  suggestedHandle = "",
  title = "Claim your handle",
  description = "Handles are claimed the first time you do something social — following, commenting, sharing a profile. Pick one now, or later from here.",
  onClaimed,
}: {
  suggestedHandle?: string;
  title?: string;
  description?: string;
  onClaimed?: (profile: SocialProfile) => void;
}) {
  const router = useRouter();
  const [handle, setHandle] = useState(suggestedHandle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<SocialProfile | null>(null);

  const normalized = handle.toLowerCase();
  const isValid = HANDLE_RE.test(normalized);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !isValid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: normalized }),
      });
      const body = (await res.json().catch(() => null)) as (SocialProfile & { error?: string }) | null;
      if (res.status === 409) {
        setError("That handle's already taken — try another.");
        return;
      }
      if (res.status === 400) {
        setError("Handles are 3–20 characters: lowercase letters, numbers, underscores.");
        return;
      }
      if (!res.ok || !body) throw new Error("Couldn't claim that handle.");
      const profile = (body.userId ? body : (body as unknown as { profile: SocialProfile }).profile) as SocialProfile;
      setClaimed(profile);
      onClaimed?.(profile);
      // Server components branch on profile existence (e.g. /friends swaps
      // the claim card for follow management) — refresh so the flow continues
      // without a manual reload.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't claim that handle.");
    } finally {
      setBusy(false);
    }
  }

  if (claimed) {
    return (
      <div className="card-flat flex items-center gap-2 p-4 text-sm text-muted">
        <Check size={18} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden />
        You&apos;re @{claimed.handle} now.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card flex flex-col gap-4 p-5">
      <div>
        <p className="section-label">Get started</p>
        <h2 className="mt-1 font-display text-xl font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">Handle</span>
        <div className="flex min-h-11 items-center gap-1.5 rounded-xl border border-border-subtle bg-surface px-3 focus-within:ring-2 focus-within:ring-accent/60">
          <AtSign size={16} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
          <input
            value={handle}
            onChange={(event) => setHandle(event.target.value.toLowerCase())}
            maxLength={20}
            placeholder="yourhandle"
            aria-label="Handle"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </div>
        <span className="text-xs text-muted">3–20 characters: lowercase letters, numbers, underscores.</span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !isValid}
        className="btn-primary min-h-11 px-4 text-sm disabled:opacity-60"
      >
        {busy ? "Claiming…" : "Claim handle"}
      </button>
    </form>
  );
}

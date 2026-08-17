"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, UserCheck, UserPlus, UserX } from "lucide-react";
import type { FollowState } from "@/db/schema";

/**
 * Non-self viewer-state actions on /u/[handle]: Follow / Requested /
 * Following (+Unfollow), and a subtle Block menu. Follow uses the handle
 * (POST /api/social/follows {handle}); unfollow/cancel-request both hit
 * DELETE /api/social/follows/[userId] — unfollow() is state-agnostic.
 */
export function FollowBlockActions({
  targetUserId,
  targetHandle,
  initialFollowState,
  followsYou,
}: {
  targetUserId: string;
  targetHandle: string;
  initialFollowState: FollowState | null;
  followsYou: boolean;
}) {
  const router = useRouter();
  const [followState, setFollowState] = useState<FollowState | null>(initialFollowState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  async function handleFollow() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/follows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: targetHandle }),
      });
      if (res.status === 409) {
        setError("Claim a handle first, from Friends.");
        return;
      }
      if (res.status === 404) {
        setError("Couldn't follow — try again later.");
        return;
      }
      const body = (await res.json().catch(() => null)) as { state?: FollowState } | null;
      if (!res.ok || !body?.state) throw new Error("Couldn't follow.");
      setFollowState(body.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't follow.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnfollow() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const previous = followState;
    setFollowState(null);
    try {
      const res = await fetch(`/api/social/follows/${targetUserId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Couldn't update that.");
    } catch (err) {
      setFollowState(previous);
      setError(err instanceof Error ? err.message : "Couldn't update that.");
    } finally {
      setBusy(false);
    }
  }

  async function handleBlock() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMenuOpen(false);
    try {
      const res = await fetch("/api/social/blocks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: targetUserId }),
      });
      if (!res.ok) throw new Error("Couldn't block.");
      router.push("/friends");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't block.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {followState === "accepted" ? (
          <button
            type="button"
            onClick={handleUnfollow}
            disabled={busy}
            className="btn-secondary tap-target inline-flex items-center gap-1.5 px-4 py-2 text-sm disabled:opacity-60"
          >
            <UserCheck size={16} strokeWidth={1.8} aria-hidden /> Following
          </button>
        ) : followState === "pending" ? (
          <button
            type="button"
            onClick={handleUnfollow}
            disabled={busy}
            className="btn-secondary tap-target inline-flex items-center gap-1.5 px-4 py-2 text-sm disabled:opacity-60"
          >
            <UserCheck size={16} strokeWidth={1.8} aria-hidden /> Requested
          </button>
        ) : (
          <button
            type="button"
            onClick={handleFollow}
            disabled={busy}
            className="btn-primary tap-target inline-flex items-center gap-1.5 px-4 py-2 text-sm disabled:opacity-60"
          >
            <UserPlus size={16} strokeWidth={1.8} aria-hidden /> {busy ? "…" : "Follow"}
          </button>
        )}
        {followsYou && <span className="chip px-3 py-1.5 text-xs">Follows you</span>}
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
            className="tap-target flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <MoreHorizontal size={18} strokeWidth={1.8} aria-hidden />
          </button>
          {menuOpen && (
            <div role="menu" className="card absolute right-0 top-full z-10 mt-1 w-36 p-1">
              <button
                type="button"
                role="menuitem"
                onClick={handleBlock}
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-danger transition-colors hover:bg-surface-raised"
              >
                <UserX size={16} strokeWidth={1.8} aria-hidden /> Block
              </button>
            </div>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, UserCheck, UserPlus } from "lucide-react";
import type { FollowState } from "@/db/schema";
import type { AddTarget } from "@/lib/social";
import { UserAvatar } from "@/components/user-avatar";
import { ProfileClaim } from "@/components/profile-claim";

/**
 * The one confirm-screen action: identity preview, then an explicit Follow
 * tap (docs/SOCIAL.md §7.2). A caller with no profile yet gets 409
 * profile_required — claim inline, then retry the same follow automatically.
 */
export function AddConfirmClient({ target }: { target: AddTarget }) {
  const { profile } = target;
  const [followState, setFollowState] = useState<FollowState | null>(target.followState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsProfile, setNeedsProfile] = useState(false);

  async function handleFollow() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/follows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: profile.handle }),
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === "profile_required") {
          setNeedsProfile(true);
          return;
        }
        setError("Couldn't follow right now — try again.");
        return;
      }
      const body = (await res.json().catch(() => null)) as { state?: FollowState } | null;
      if (!res.ok || !body?.state) {
        setError("Couldn't follow — try again.");
        return;
      }
      setNeedsProfile(false);
      setFollowState(body.state);
    } catch {
      setError("Couldn't follow — try again.");
    } finally {
      setBusy(false);
    }
  }

  const mutual = followState === "accepted" && target.followsYou;

  return (
    <div className="card flex flex-col items-center gap-4 p-6 text-center">
      <UserAvatar name={profile.displayName || profile.handle} image={profile.avatarUrl} size={72} />
      <div>
        <h1 className="font-display text-2xl font-semibold leading-tight">
          {profile.displayName || `@${profile.handle}`}
        </h1>
        <p className="text-sm text-muted">@{profile.handle}</p>
      </div>

      {(mutual || target.followsYou) && (
        <span className={`chip px-3 py-1 text-xs ${mutual ? "chip-active" : ""}`}>
          {mutual ? "Friends" : "Follows you"}
        </span>
      )}

      {needsProfile ? (
        <div className="w-full">
          <ProfileClaim
            title="Claim a handle to follow"
            description="You need a handle before you can follow anyone — pick one now and this will finish automatically."
            onClaimed={() => {
              setNeedsProfile(false);
              void handleFollow();
            }}
          />
        </div>
      ) : (
        <div className="flex w-full flex-col items-center gap-2">
          {followState === "accepted" ? (
            <span className="btn-secondary tap-target inline-flex min-h-11 w-full items-center justify-center gap-1.5 px-4 text-sm">
              <Check size={16} strokeWidth={1.8} aria-hidden /> Following
            </span>
          ) : followState === "pending" ? (
            <span className="btn-secondary tap-target inline-flex min-h-11 w-full items-center justify-center gap-1.5 px-4 text-sm">
              <UserCheck size={16} strokeWidth={1.8} aria-hidden /> Requested
            </span>
          ) : (
            <button
              type="button"
              onClick={handleFollow}
              disabled={busy}
              className="btn-primary tap-target inline-flex min-h-11 w-full items-center justify-center gap-1.5 px-4 text-sm disabled:opacity-60"
            >
              <UserPlus size={16} strokeWidth={1.8} aria-hidden /> {busy ? "Following…" : "Follow"}
            </button>
          )}
          <Link href={`/u/${profile.handle}`} className="text-sm text-accent">
            View profile
          </Link>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {followState && !needsProfile && (
        <Link href="/friends" className="btn-secondary mt-2 px-6 py-2.5 text-sm">
          Back to Friends
        </Link>
      )}
    </div>
  );
}

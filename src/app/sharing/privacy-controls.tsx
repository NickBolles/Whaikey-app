"use client";

import { useState } from "react";
import Link from "next/link";
import { ToggleSwitch } from "@/components/toggle-switch";
import type { PourVisibility } from "@/db/schema";

const VISIBILITY_OPTIONS: Array<{ value: PourVisibility; label: string; description: string }> = [
  { value: "private", label: "Only me", description: "Nothing is shared automatically." },
  { value: "friends", label: "Friends", description: "Visible to people who follow you back." },
  { value: "followers", label: "Followers", description: "Visible to everyone who follows you." },
  { value: "public", label: "Public", description: "Visible to any signed-in Whaikey user." },
];

export interface PrivacyControlsProps {
  hasProfile: boolean;
  initialDefaultVisibility: PourVisibility;
  initialAllowComments: boolean;
  initialSocialEnabled: boolean;
}

/**
 * US-6/US-11 controls, added to /sharing alongside Agent A's shared-links
 * list: the default-visibility pref for new pours, an allow-comments toggle,
 * and the step-back switch (POST /api/social/privacy-reset) with its
 * reversible re-enable (PATCH /api/social/profile { socialEnabled }).
 */
export function PrivacyControls({
  hasProfile,
  initialDefaultVisibility,
  initialAllowComments,
  initialSocialEnabled,
}: PrivacyControlsProps) {
  const [visibility, setVisibility] = useState(initialDefaultVisibility);
  const [allowComments, setAllowComments] = useState(initialAllowComments);
  const [socialEnabled, setSocialEnabled] = useState(initialSocialEnabled);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Saves run one at a time and the UI reconciles from the SERVER's response:
   * two overlapping PATCHes could otherwise commit out of order and leave the
   * database default broader than what the screen shows.
   */
  async function patchPrefs(patch: Partial<{ defaultPourVisibility: PourVisibility; allowComments: boolean }>) {
    const res = await fetch("/api/social/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error("Couldn't save that.");
    const saved = (await res.json().catch(() => null)) as {
      defaultPourVisibility?: PourVisibility;
      allowComments?: boolean;
    } | null;
    if (saved?.defaultPourVisibility) setVisibility(saved.defaultPourVisibility);
    if (typeof saved?.allowComments === "boolean") setAllowComments(saved.allowComments);
  }

  async function handleVisibility(value: PourVisibility) {
    if (value === visibility || busy || saving) return;
    const previous = visibility;
    setVisibility(value);
    setSaving(true);
    setError(null);
    try {
      await patchPrefs({ defaultPourVisibility: value });
    } catch (err) {
      setVisibility(previous);
      setError(err instanceof Error ? err.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  async function handleAllowComments(next: boolean) {
    if (busy || saving) return;
    const previous = allowComments;
    setAllowComments(next);
    setSaving(true);
    setError(null);
    try {
      await patchPrefs({ allowComments: next });
    } catch (err) {
      setAllowComments(previous);
      setError(err instanceof Error ? err.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  async function handlePrivacyReset() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/privacy-reset", { method: "POST" });
      if (!res.ok) throw new Error("Couldn't step back right now.");
      setSocialEnabled(false);
      setVisibility("private");
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't step back right now.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReenable() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ socialEnabled: true }),
      });
      if (!res.ok) throw new Error("Couldn't turn social back on.");
      setSocialEnabled(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't turn social back on.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card flex flex-col gap-5 p-5">
      <div>
        <p className="section-label">Privacy</p>
        <h2 className="mt-1 font-display text-xl font-semibold">Sharing defaults</h2>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm">Default visibility for new pours</span>
        <div className="flex flex-wrap gap-2">
          {VISIBILITY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleVisibility(opt.value)}
              aria-pressed={visibility === opt.value}
              className={`chip tap-target px-3 py-1.5 text-xs ${visibility === opt.value ? "chip-active" : ""}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">{VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.description}</p>
      </div>

      {!hasProfile && (
        <p className="text-xs text-muted">
          Comment settings appear once you set up a profile from{" "}
          <Link href="/friends" className="text-accent hover:brightness-110 transition-[filter]">
            Friends
          </Link>
          .
        </p>
      )}

      {hasProfile && (
        <ToggleSwitch
          label="Allow comments"
          hint="People who can see a note can reply under it."
          checked={allowComments}
          onChange={handleAllowComments}
        />
      )}

      {/* The US-11 bulk reset is a safety action and never requires a profile:
          an S1 sharer with active bearer links must be able to revoke
          everything in one tap. The re-enable block is profile-only. */}
      {(!hasProfile || socialEnabled) ? (
            <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
              <span className="text-sm">Step back from social</span>
              {!confirming ? (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="tap-target inline-flex w-fit min-h-11 items-center rounded-xl border border-danger/50 bg-danger/10 px-4 text-sm font-medium text-danger transition-colors hover:bg-danger/15"
                >
                  Make everything private
                </button>
              ) : (
                <div className="card-flat flex flex-col gap-3 p-4">
                  <p className="text-sm text-foreground/90">
                    Every pour goes to Only me, every shared link is revoked, and your profile is hidden. Nothing is
                    deleted, and you can turn social back on any time.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handlePrivacyReset}
                      disabled={busy}
                      className="tap-target inline-flex min-h-11 items-center rounded-xl border border-danger/50 bg-danger/10 px-4 text-sm font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-60"
                    >
                      {busy ? "Working…" : "Yes, make everything private"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      className="btn-secondary tap-target min-h-11 px-4 text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="card-flat flex flex-col gap-2 p-4">
              <p className="text-sm text-foreground/90">
                Social is off. Your profile is hidden and pours stay private until you turn it back on.
              </p>
              <button
                type="button"
                onClick={handleReenable}
                disabled={busy}
                className="btn-primary tap-target w-fit min-h-11 px-4 text-sm disabled:opacity-60"
              >
                {busy ? "Working…" : "Turn social back on"}
              </button>
            </div>
          )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

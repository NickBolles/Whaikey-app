"use client";

import { useState, type FormEvent } from "react";
import { Pencil, X } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import { ToggleSwitch } from "@/components/toggle-switch";
import type { SocialProfile } from "@/lib/social";

/** Self-view of /u/[handle]: identity display plus the inline "Edit profile" form (PATCH /api/social/profile). */
export function ProfileEditor({ profile: initial }: { profile: SocialProfile }) {
  const [profile, setProfile] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [bio, setBio] = useState(initial.bio ?? "");
  const [homeRegion, setHomeRegion] = useState(initial.homeRegion ?? "");
  const [isPublic, setIsPublic] = useState(initial.isPublic);
  const [discoverable, setDiscoverable] = useState(initial.discoverable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openEditor() {
    setDisplayName(profile.displayName);
    setBio(profile.bio ?? "");
    setHomeRegion(profile.homeRegion ?? "");
    setIsPublic(profile.isPublic);
    setDiscoverable(profile.discoverable);
    setError(null);
    setEditing(true);
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim(),
          bio: bio.trim() || null,
          homeRegion: homeRegion.trim() || null,
          isPublic,
          discoverable,
        }),
      });
      const body = (await res.json().catch(() => null)) as (SocialProfile & { error?: string }) | null;
      if (!res.ok || !body) throw new Error("Couldn't save your profile.");
      const next = ("userId" in body ? body : (body as unknown as { profile: SocialProfile }).profile) as SocialProfile;
      setProfile(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <UserAvatar name={profile.displayName || profile.handle} image={profile.avatarUrl} size={64} />
          <div>
            <h1 className="font-display text-2xl font-semibold leading-tight">
              {profile.displayName || `@${profile.handle}`}
            </h1>
            <p className="text-sm text-muted">@{profile.handle}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => (editing ? setEditing(false) : openEditor())}
          className="tap-target inline-flex items-center gap-1.5 rounded-xl border border-border-subtle px-3 py-2 text-xs text-muted transition-colors hover:border-accent/60 hover:text-foreground"
        >
          {editing ? <X size={14} strokeWidth={1.8} aria-hidden /> : <Pencil size={14} strokeWidth={1.8} aria-hidden />}
          {editing ? "Cancel" : "Edit profile"}
        </button>
      </div>

      {!editing && (
        <>
          {profile.bio && <p className="text-foreground/90">{profile.bio}</p>}
          {profile.homeRegion && <p className="text-sm text-muted">{profile.homeRegion}</p>}
          {!profile.isPublic && (
            <p className="text-xs text-muted">Private profile — only approved followers see your palate.</p>
          )}
        </>
      )}

      {editing && (
        <form onSubmit={handleSave} className="card flex flex-col gap-4 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={80}
              className="min-h-11 rounded-xl border border-border-subtle bg-surface px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">Bio</span>
            <textarea
              value={bio}
              onChange={(event) => setBio(event.target.value)}
              maxLength={280}
              rows={3}
              className="rounded-xl border border-border-subtle bg-surface p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">Home region</span>
            <input
              value={homeRegion}
              onChange={(event) => setHomeRegion(event.target.value)}
              maxLength={80}
              className="min-h-11 rounded-xl border border-border-subtle bg-surface px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            />
          </label>
          <div className="flex flex-col gap-2">
            <ToggleSwitch
              label="Public profile"
              hint="Anyone can follow without approval."
              checked={isPublic}
              onChange={setIsPublic}
            />
            {/* The flag never gates exact-handle lookup (docs/SOCIAL.md §7.1:
                exact handle always resolves) — it only opts out of future
                suggestion surfaces, so the copy must not overclaim. */}
            <ToggleSwitch
              label="Discoverable"
              hint="May appear in future friend suggestions. Your exact handle always resolves."
              checked={discoverable}
              onChange={setDiscoverable}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className="btn-primary min-h-11 px-4 text-sm disabled:opacity-60">
            {busy ? "Saving…" : "Save changes"}
          </button>
        </form>
      )}
    </div>
  );
}

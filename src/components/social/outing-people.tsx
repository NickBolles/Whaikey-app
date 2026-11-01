"use client";

import { useEffect, useId, useState } from "react";
import { UserCheck, UserPlus, X } from "lucide-react";
import type { MemberFriendState, OutingMember } from "@/lib/outings/presence";
import { PRESENCE_HEARTBEAT_MS } from "@/lib/outings/presence";
import { useScrollLock } from "@/lib/scroll-lock";

const initial = (name: string) => (name.replace(/^@/, "").trim()[0] ?? "?").toUpperCase();

function Avatar({ m, size = 32 }: { m: OutingMember; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        aria-hidden
        className="flex h-full w-full items-center justify-center rounded-full border border-border bg-surface-raised text-xs font-semibold"
      >
        {initial(m.name)}
      </span>
      {m.hereNow && (
        <span
          data-testid="here-now-dot"
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background bg-success"
        />
      )}
    </span>
  );
}

/** Add / Requested / Friends / Following / You — reuses POST /api/social/follows {handle}. */
export function FriendButton({ handle, initial: start }: { handle: string | null; initial: MemberFriendState }) {
  const [state, setState] = useState<MemberFriendState>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state === "none") return null;
  if (state === "you") return <span className="chip px-2.5 py-1 text-xs">You</span>;
  if (state === "friends" || state === "following" || state === "requested") {
    return (
      <span className="chip inline-flex items-center gap-1 px-2.5 py-1 text-xs">
        <UserCheck size={14} strokeWidth={1.8} aria-hidden /> {state === "friends" ? "Friends" : state === "following" ? "Following" : "Requested"}
      </span>
    );
  }

  async function add() {
    if (busy || !handle) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/follows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle }),
      });
      if (res.status === 409) {
        setError("Claim a handle first, from Friends.");
        return;
      }
      const body = (await res.json().catch(() => null)) as { state?: "pending" | "accepted" } | null;
      if (!res.ok || !body?.state) throw new Error("Couldn't send that — try again.");
      setState(body.state === "accepted" ? "following" : "requested");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={add}
        disabled={busy}
        className="btn-primary tap-target inline-flex items-center gap-1 px-3 py-1.5 text-xs disabled:opacity-60"
      >
        <UserPlus size={14} strokeWidth={1.8} aria-hidden /> {busy ? "…" : "Add friend"}
      </button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * The outing's People strip + sheet: who's on the trip, the host badge, a
 * small dot on anyone with the outing open in the app in the last 2 minutes,
 * and Add friend per person. Shown only to people on the outing. Sends a
 * heartbeat every ~45 s while the page is visible (only when `heartbeat`).
 */
export function OutingPeople({ code, members, heartbeat }: { code: string; members: OutingMember[]; heartbeat: boolean }) {
  const [open, setOpen] = useState(false);
  const [here, setHere] = useState<Set<string> | null>(null);
  const me = members.find((m) => m.isYou);
  const [showMe, setShowMe] = useState(me?.showPresence ?? true);
  const [savingShow, setSavingShow] = useState(false);
  const titleId = useId();
  useScrollLock(open);

  async function toggleShowMe(next: boolean) {
    setSavingShow(true);
    const previous = showMe;
    setShowMe(next);
    try {
      const res = await fetch(`/api/outings/${encodeURIComponent(code)}/presence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ show: next }),
      });
      const body = (await res.json().catch(() => null)) as { here?: string[]; show?: boolean } | null;
      if (!res.ok || !body) throw new Error();
      if (body.here) setHere(new Set(body.here));
      if (typeof body.show === "boolean") setShowMe(body.show);
    } catch {
      setShowMe(previous);
    } finally {
      setSavingShow(false);
    }
  }

  useEffect(() => {
    if (!heartbeat) return;
    let stopped = false;
    async function beat() {
      if (stopped || (typeof document !== "undefined" && document.visibilityState !== "visible")) return;
      try {
        const res = await fetch(`/api/outings/${encodeURIComponent(code)}/presence`, { method: "POST" });
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { here?: string[] } | null;
        if (!stopped && body?.here) setHere(new Set(body.here));
      } catch {
        // offline at the bar — try again on the next beat
      }
    }
    void beat();
    const timer = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [code, heartbeat]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (members.length === 0) return null;
  const people = members.map((m) => {
    if (m.isYou) return { ...m, hereNow: showMe && heartbeat };
    return here ? { ...m, hereNow: here.has(m.participantId) } : m;
  });
  const hereCount = people.filter((m) => m.hereNow).length;
  const shown = people.slice(0, 6);

  return (
    <section aria-label="People on this outing">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="card-flat tap-target flex w-full items-center gap-3 p-2.5 text-left"
        aria-haspopup="dialog"
      >
        <span className="flex -space-x-2">
          {shown.map((m) => (
            <Avatar key={m.participantId} m={m} size={30} />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">
            People · {people.length}
          </span>
          <span className="block truncate text-xs text-muted">
            {hereCount > 0 ? `${hereCount} here now · ` : ""}
            {people.map((m) => (m.isYou ? "You" : m.name)).join(", ")}
          </span>
        </span>
        <span className="shrink-0 text-xs text-accent">See all</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85dvh] w-full max-w-sm overflow-y-auto overscroll-contain rounded-t-2xl border border-border bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-lg sm:rounded-2xl"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 id={titleId} className="font-display text-lg font-semibold">
                People on this outing · {people.length}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="tap-target flex h-9 w-9 items-center justify-center rounded-xl text-muted hover:bg-surface-raised hover:text-foreground"
              >
                <X size={18} strokeWidth={1.8} aria-hidden />
              </button>
            </div>
            <p className="mt-1 text-xs text-muted">A green dot means they have this outing open in the app right now. Only people on this outing see it.</p>
            {heartbeat && me && (
              <label className="mt-3 flex min-h-11 items-center justify-between gap-3 text-sm">
                <span>Show when I&rsquo;m here</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={showMe}
                  disabled={savingShow}
                  onChange={(e) => void toggleShowMe(e.target.checked)}
                  className="h-5 w-5 accent-[var(--color-accent)]"
                />
              </label>
            )}
            <ul className="mt-3 flex flex-col divide-y divide-border-subtle">
              {people.map((m) => (
                <li key={m.participantId} className="flex items-center gap-3 py-2.5">
                  <Avatar m={m} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{m.isYou ? `${m.name} (you)` : m.name}</span>
                      {m.isHost && <span className="chip px-1.5 py-0.5 text-[0.7rem]">Host</span>}
                    </span>
                    <span className="block text-xs text-muted">
                      {m.handle ? `@${m.handle}` : m.guest ? "Guest" : ""}
                      {m.hereNow ? `${m.handle || m.guest ? " · " : ""}Here now` : ""}
                    </span>
                  </span>
                  <FriendButton handle={m.handle} initial={m.friend} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { DELETE_CONFIRMATION, isDeleteConfirmation } from "@/lib/account-confirm";
import { disablePush } from "@/lib/native/push";
import { useScrollLock } from "@/lib/scroll-lock";

/**
 * Settings → Your data (WP-11): export, one tap, no tier; and deletion behind
 * a typed confirmation.
 *
 * The export buttons are plain download links rather than a fetch: the
 * browser streams the file straight to disk with the session cookie it
 * already has, and there is no state here to get wrong.
 */
export function YourData() {
  return (
    <section aria-labelledby="your-data-heading" className="card flex flex-col gap-5 p-5">
      <div>
        <p className="section-label">Your data</p>
        <h2 id="your-data-heading" className="mt-1 font-display text-xl font-semibold">
          Take it with you
        </h2>
        <p className="mt-1 text-sm text-muted">
          Everything you have written — shelf, pours, notes, conversations, profile and who you
          follow — free, always. Other people&rsquo;s notes and comments are never in it.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <a
          href="/api/account/export?format=json"
          download
          className="btn-secondary tap-target inline-flex min-h-11 items-center gap-2 px-4 text-sm"
        >
          <Download size={18} strokeWidth={1.8} aria-hidden /> Download JSON
        </a>
        <a
          href="/api/account/export?format=csv"
          download
          className="btn-secondary tap-target inline-flex min-h-11 items-center gap-2 px-4 text-sm"
        >
          <Download size={18} strokeWidth={1.8} aria-hidden /> Download CSV (zip)
        </a>
      </div>

      <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
        <span className="text-sm">Delete your account</span>
        <p className="text-xs leading-relaxed text-muted">
          Permanently, straight away, with no undo. What goes and what stays is in the{" "}
          <a href="/privacy#getting-it-out" className="text-accent">
            privacy policy
          </a>
          .
        </p>
        <DeleteAccount />
      </div>
    </section>
  );
}

type Phase = "idle" | "deleting" | "deleted";

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useScrollLock(open);

  const confirmed = isDeleteConfirmation(typed);
  const busy = phase !== "idle";

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && phase === "idle") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, phase]);

  function close() {
    setOpen(false);
    setTyped("");
    setError(null);
    triggerRef.current?.focus();
  }

  async function handleDelete() {
    if (!confirmed || busy) return;
    setPhase("deleting");
    setError(null);
    // This device's push registration first, while there is still a session
    // to release it with. Best effort: the server deletes every registration
    // with the account anyway, and a failure here must not stop the deletion.
    await disablePush().catch(() => false);
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setPhase("deleted");
      // A hard navigation: every cached render above this one was made for an
      // account that no longer exists.
      window.location.href = "/";
    } catch {
      setPhase("idle");
      setError("Couldn't delete the account — nothing was removed. Check your connection and try again.");
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="tap-target inline-flex w-fit min-h-11 items-center gap-2 rounded-xl border border-danger/50 bg-danger/10 px-4 text-sm font-medium text-danger transition-colors hover:bg-danger/15"
      >
        <Trash2 size={18} strokeWidth={1.8} aria-hidden /> Delete account…
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 px-4 pb-8 sm:items-center"
          onClick={(event) => {
            if (event.target === event.currentTarget && !busy) close();
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            className="card flex w-full max-w-md flex-col gap-4 p-5"
          >
            <h2 id={titleId} className="font-display text-xl font-semibold">
              Delete your account?
            </h2>
            <div id={bodyId} className="flex flex-col gap-2 text-sm leading-relaxed text-foreground/90">
              <p>
                Your shelf, pours, tasting notes, passport, concierge conversations, profile and share
                links are deleted — all at once, and it cannot be undone. Every device is signed out.
              </p>
              <p className="text-muted">
                Comments and cheers you left on other people&rsquo;s notes go too. Reports you filed
                stay with the moderators, without your name. If you want a copy, download it first.
              </p>
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span>
                Type <strong className="font-mono text-foreground">{DELETE_CONFIRMATION}</strong> to confirm
              </span>
              <input
                ref={inputRef}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                disabled={busy}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="min-h-11 rounded-xl border border-border-subtle bg-surface px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              />
            </label>

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={!confirmed || busy}
                className="tap-target inline-flex min-h-11 items-center rounded-xl border border-danger/60 bg-danger/15 px-4 text-sm font-semibold text-danger transition-colors hover:bg-danger/25 disabled:opacity-50"
              >
                {phase === "deleting" ? "Deleting…" : phase === "deleted" ? "Deleted" : "Delete my account"}
              </button>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="btn-secondary tap-target min-h-11 px-4 text-sm disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

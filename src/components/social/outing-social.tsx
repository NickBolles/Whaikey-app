"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { OUTING_COMMENT_MAX, OUTING_REACTIONS, type OutingCommentView, type OutingReactionView, type OutingTargetKind } from "@/lib/outings/social";

/**
 * Replies and reactions on an outing bottle or rating. Compact chips (a small
 * glyph plus a word), who reacted on hover or long-press, short replies with
 * @mentions of people on the outing. Everything shows up for the group via
 * the live stream; nothing is pushed anywhere else.
 */

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  return res?.status ?? 0;
}

function Who({ r }: { r: OutingReactionView }) {
  return (
    <span className="text-[11px] text-muted">
      {r.label}: {r.who.join(", ")}
    </span>
  );
}

export function ReactionChips({
  code,
  targetKind,
  targetId,
  reactions,
  canReact,
  compact = false,
}: {
  code: string;
  targetKind: OutingTargetKind;
  targetId: string;
  reactions: OutingReactionView[];
  canReact: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showWho, setShowWho] = useState<string | null>(null);
  const hold = useRef<number | null>(null);
  const byKind = new Map(reactions.map((r) => [r.kind, r]));
  async function toggle(kind: string) {
    if (!canReact || busy) return;
    setBusy(kind);
    const on = !byKind.get(kind as OutingReactionView["kind"])?.mine;
    await call(`/api/outings/${encodeURIComponent(code)}/reactions`, "POST", { targetKind, targetId, kind, on });
    setBusy(null);
    setPicking(false);
    router.refresh();
  }
  const startHold = (kind: string) => {
    hold.current = window.setTimeout(() => setShowWho(kind), 450);
  };
  const endHold = () => {
    if (hold.current != null) window.clearTimeout(hold.current);
    hold.current = null;
  };
  const shown = picking ? OUTING_REACTIONS.map((k) => byKind.get(k.id) ?? { kind: k.id, label: k.label, glyph: k.glyph, count: 0, who: [], mine: false }) : reactions;
  if (!shown.length && !canReact) return null;
  const whoFor = showWho ? byKind.get(showWho as OutingReactionView["kind"]) : undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5 py-1" role="group" aria-label="Reactions">
        {shown.map((r) => {
          const hint = OUTING_REACTIONS.find((k) => k.id === r.kind)?.hint ?? r.label;
          const who = r.who.length ? ` — ${r.who.join(", ")}` : "";
          return (
            <button
              key={r.kind}
              type="button"
              aria-pressed={r.mine}
              disabled={!canReact || busy != null}
              title={`${hint}${who}`}
              aria-label={`${hint}${r.count ? `, ${r.count} ${r.count === 1 ? "person" : "people"}` : ""}${who}`}
              onClick={() => void toggle(r.kind)}
              onPointerDown={() => startHold(r.kind)}
              onPointerUp={endHold}
              onPointerLeave={endHold}
              onContextMenu={(e) => {
                e.preventDefault();
                setShowWho(r.kind);
              }}
              className={`tap-target inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-5 ${
                r.mine ? "border-accent text-accent" : "border-border text-foreground/80"
              } disabled:opacity-70`}
            >
              <span aria-hidden className="font-mono">
                {r.glyph}
              </span>
              {!compact || picking ? <span>{r.label}</span> : null}
              {r.count > 0 && <span className="tabular-nums text-muted">{r.count}</span>}
            </button>
          );
        })}
        {canReact && (
          <button
            type="button"
            aria-expanded={picking}
            onClick={() => setPicking((p) => !p)}
            className="tap-target rounded-full px-2 py-0.5 text-[11px] leading-5 text-muted hover:text-foreground"
          >
            {picking ? "Close" : "React"}
          </button>
        )}
      </div>
      {whoFor && whoFor.who.length > 0 && <Who r={whoFor} />}
    </div>
  );
}

function Body({ text }: { text: string }) {
  const parts = text.split(/(@[\p{L}\p{N}_.-]{2,40})/u);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          <span key={i} className="font-medium text-accent">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function Replies({
  code,
  targetKind,
  targetId,
  comments,
  canReply,
  isHost,
  about,
}: {
  code: string;
  targetKind: OutingTargetKind;
  targetId: string;
  comments: OutingCommentView[];
  canReply: boolean;
  isHost: boolean;
  /** What is being replied to, for labels ("Lagavulin 16", "Ana's rating"). */
  about: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/outings/${encodeURIComponent(code)}/comments`;
  async function submit() {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    const status = editing ? await call(`${base}/${encodeURIComponent(editing)}`, "PATCH", { body }) : await call(base, "POST", { targetKind, targetId, body });
    setBusy(false);
    if (status >= 200 && status < 300) {
      setText("");
      setEditing(null);
      setOpen(false);
      setError(null);
      router.refresh();
    } else setError(status === 0 ? "No signal. Try again when you're back online." : status === 429 ? "That's the reply limit for this outing." : "Couldn't post that reply.");
  }
  async function remove(id: string) {
    const status = await call(`${base}/${encodeURIComponent(id)}`, "DELETE");
    if (status >= 200 && status < 300) router.refresh();
    else setError("Couldn't remove that reply.");
  }
  return (
    <div className="flex flex-col gap-1">
      {comments.length > 0 && (
        <ul className="flex flex-col gap-1 border-l border-border pl-2" aria-label={`Replies on ${about}`}>
          {comments.map((c) => (
            <li key={c.id} className="text-xs">
              <span className={c.mine ? "font-medium" : "font-medium text-foreground/90"}>{c.who}</span>
              {c.mentionsMe && <span className="ml-1 text-[10px] uppercase tracking-wide text-accent">mentioned you</span>}
              <span className="block text-foreground/85">
                <Body text={c.body} />
                {c.edited && <span className="ml-1 text-muted">(edited)</span>}
              </span>
              {(c.mine || isHost) && (
                <span className="flex gap-2">
                  {c.mine && canReply && (
                    <button
                      type="button"
                      className="tap-target text-[11px] text-muted hover:text-foreground"
                      onClick={() => {
                        setEditing(c.id);
                        setText(c.body);
                        setOpen(true);
                      }}
                    >
                      Edit
                    </button>
                  )}
                  <button type="button" className="tap-target text-[11px] text-muted hover:text-foreground" onClick={() => void remove(c.id)}>
                    {c.mine ? "Delete" : "Hide"}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canReply && !open && (
        <button type="button" className="tap-target self-start py-1 text-xs text-accent" onClick={() => setOpen(true)} aria-label={`Reply on ${about}`}>
          Reply
        </button>
      )}
      {open && (
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="sr-only" htmlFor={`reply-${targetKind}-${targetId}`}>
            {editing ? "Edit your reply" : `Reply on ${about}`}
          </label>
          <textarea
            id={`reply-${targetKind}-${targetId}`}
            value={text}
            maxLength={OUTING_COMMENT_MAX}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a reply. Use @name to mention someone here."
            className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-base"
          />
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy || !text.trim()} className="btn-primary px-3 py-1.5 text-xs disabled:opacity-60">
              {busy ? "Posting…" : editing ? "Save" : "Post reply"}
            </button>
            <button
              type="button"
              className="tap-target text-xs text-muted"
              onClick={() => {
                setOpen(false);
                setEditing(null);
                setText("");
              }}
            >
              Cancel
            </button>
            <span className="ml-auto text-[11px] tabular-nums text-muted">{OUTING_COMMENT_MAX - text.length}</span>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

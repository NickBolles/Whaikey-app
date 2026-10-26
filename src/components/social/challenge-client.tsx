"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TRAIL } from "@/lib/challenges/term";
import { RULE_KINDS, RULE_KIND_IDS, type RuleKindId } from "@/lib/challenges/kinds";

async function call(url: string, method: string, body?: unknown) {
  return fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
}

export function JoinChallengeButton({ slug, joined, completed }: { slug: string; joined: boolean; completed: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (completed) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await call(`/api/challenges/${slug}`, joined ? "DELETE" : "POST");
        setBusy(false);
        router.refresh();
      }}
      className={`tap-target ${joined ? "px-2 text-xs text-muted hover:text-foreground" : "btn-secondary px-3 py-1.5 text-sm"} disabled:opacity-60`}
    >
      {joined ? "Leave" : "Join"}
    </button>
  );
}

export function BoardOptIn({ optedIn }: { optedIn: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await call("/api/challenges/board", "POST", { optIn: !optedIn });
        setBusy(false);
        router.refresh();
      }}
      className={`tap-target ${optedIn ? "px-2 text-xs text-muted hover:text-foreground" : "btn-secondary px-3 py-1.5 text-sm"} disabled:opacity-60`}
    >
      {optedIn ? "Leave the board" : "Join the board"}
    </button>
  );
}

/** Owner/admin: a club trail (internally a club challenge) from the distinct-only templates (C6). */
export function ClubChallengeForm({ clubId }: { clubId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<RuleKindId>("distinct_countries");
  const [target, setTarget] = useState(3);
  const [days, setDays] = useState(30);
  const [error, setError] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="tap-target text-xs font-medium text-accent">
        Start a club {TRAIL.lower} →
      </button>
    );
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(false);
        const res = await call(`/api/clubs/${clubId}/challenges`, "POST", { title, rule: { kind, target }, days });
        if (res?.status === 201) router.push(TRAIL.path);
        else setError(true);
      }}
      className="flex flex-col gap-2 text-sm"
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name it" maxLength={60} aria-label={`${TRAIL.one} name`} className="rounded-lg border border-border-subtle bg-surface px-3 py-2" />
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted">Different…</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as RuleKindId)} className="rounded-lg border border-border-subtle bg-surface px-2 py-2">
            {RULE_KIND_IDS.map((k) => (
              <option key={k} value={k}>
                {RULE_KINDS[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-20 flex-col gap-1">
          <span className="text-xs text-muted">How many</span>
          <input type="number" min={1} max={25} value={target} onChange={(e) => setTarget(Number(e.target.value))} className="rounded-lg border border-border-subtle bg-surface px-2 py-2" />
        </label>
        <label className="flex w-20 flex-col gap-1">
          <span className="text-xs text-muted">Days</span>
          <input type="number" min={7} max={92} value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-border-subtle bg-surface px-2 py-2" />
        </label>
      </div>
      <p className="text-xs text-muted">{TRAIL.many} count different things met, never how much — a repeat counts for nothing.</p>
      <button type="submit" className="btn-primary py-2 text-sm">
        Start it
      </button>
      {error && (
        <p role="status" className="text-xs text-muted">
          Couldn&rsquo;t start it — check the name and numbers.
        </p>
      )}
    </form>
  );
}

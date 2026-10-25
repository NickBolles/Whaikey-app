"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

interface Pick {
  id: string;
  name: string;
}

const SLOTS = ["A", "B", "C", "D", "E", "F"];

export function NewFlightForm({ clubs, defaultClubId }: { clubs: Array<{ id: string; name: string }>; defaultClubId: string }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [blind, setBlind] = useState(true);
  const [clubId, setClubId] = useState(defaultClubId);
  const [when, setWhen] = useState("");
  const [picks, setPicks] = useState<Pick[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Pick[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/bottles/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((d: { results?: Pick[] }) => setResults((d.results ?? []).slice(0, 6)))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/flights", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        blind,
        bottleIds: picks.map((p) => p.id),
        ...(clubId ? { clubId } : {}),
        ...(when ? { scheduledAt: new Date(when).toISOString() } : {}),
      }),
    }).catch(() => null);
    setBusy(false);
    if (res?.status === 201) {
      const { path } = (await res.json()) as { path: string };
      router.push(path);
    } else setError("Couldn't create the tasting night — check the title and pick 3 to 6 bottles.");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Islay night" required className="rounded-lg border border-border-subtle bg-surface px-3 py-2" />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          Blind
          <span className="block text-xs text-muted">Bottles stay hidden behind letters until you reveal.</span>
        </span>
        <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} className="h-4 w-4" />
      </label>
      {clubs.length > 0 && (
        <label className="flex flex-col gap-1 text-sm">
          Club (optional — members get an invite)
          <select value={clubId} onChange={(e) => setClubId(e.target.value)} className="rounded-lg border border-border-subtle bg-surface px-3 py-2">
            <option value="">No club</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        When (optional)
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="rounded-lg border border-border-subtle bg-surface px-3 py-2" />
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm">Bottles ({picks.length}/6)</legend>
        <ol className="flex flex-col gap-1">
          {picks.map((p, i) => (
            <li key={p.id} className="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-1.5 text-sm">
              <span className="font-display font-semibold text-accent">{SLOTS[i]}</span>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setPicks(picks.filter((x) => x.id !== p.id))} className="text-muted hover:text-foreground">
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ol>
        {picks.length < 6 && (
          <>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search a bottle to add"
              aria-label="Search a bottle to add"
              className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm"
            />
            {q.trim().length >= 2 && results.length > 0 && (
              <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
                {results
                  .filter((r) => !picks.some((p) => p.id === r.id))
                  .map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPicks([...picks, { id: r.id, name: r.name }]);
                          setQ("");
                          setResults([]);
                        }}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-surface-raised"
                      >
                        {r.name}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </>
        )}
      </fieldset>

      <button type="submit" disabled={busy || picks.length < 3 || title.trim().length < 2} className="btn-primary py-2.5 disabled:opacity-60">
        {busy ? "Setting the table…" : "Create tasting night"}
      </button>
      {error && (
        <p role="status" className="text-sm text-muted">
          {error}
        </p>
      )}
    </form>
  );
}

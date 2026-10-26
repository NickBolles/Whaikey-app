"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const TIERS = [
  { id: "queue", label: "Queue (unfinished live jobs)" },
  { id: "keyword", label: "Keyword (free)" },
  { id: "missing", label: "Missing profiles (quick model)" },
  { id: "web", label: "Popular → web tier" },
] as const;

/** Operator controls for /admin/enrichment. Plain on purpose: one person's tool. */
export function EnrichmentControls({
  paused,
  dailyBudgetUsd,
  live,
  failed,
}: {
  paused: boolean;
  dailyBudgetUsd: number;
  live: boolean;
  failed: number;
}) {
  const router = useRouter();
  const [budget, setBudget] = useState(String(dailyBudgetUsd));
  const [tiers, setTiers] = useState<string[]>(["queue", "missing"]);
  const [bottleId, setBottleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, done: (json: Record<string, unknown>) => string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/enrichment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setMessage(res.ok ? done(json) : String(json.error ?? `Failed (${res.status})`));
      router.refresh();
    } catch {
      setMessage("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="controls" className="flex flex-col gap-2">
      <h2 id="controls" className="text-[11px] font-semibold uppercase tracking-wide text-muted">Controls</h2>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          Daily budget (USD, hard stop)
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="w-28 rounded-lg border border-border-subtle bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          className="btn-secondary min-h-11 px-3 text-xs"
          onClick={() => post({ action: "settings", dailyBudgetUsd: Number(budget) }, () => "Budget saved")}
        >
          Save budget
        </button>
        <button
          type="button"
          disabled={busy}
          className="btn-secondary min-h-11 px-3 text-xs"
          onClick={() => post({ action: "settings", paused: !paused }, () => (paused ? "Resumed" : "Paused"))}
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          disabled={busy || failed === 0}
          className="btn-secondary min-h-11 px-3 text-xs"
          onClick={() => post({ action: "retry-failed" }, (j) => `Requeued ${j.requeued}`)}
        >
          Retry failures ({failed})
        </button>
      </div>
      <fieldset className="flex flex-wrap items-center gap-3 text-xs">
        <legend className="sr-only">Tiers to run</legend>
        {TIERS.map((t) => (
          <label key={t.id} className="flex min-h-11 items-center gap-1.5">
            <input
              type="checkbox"
              checked={tiers.includes(t.id)}
              onChange={(e) => setTiers((cur) => (e.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id)))}
            />
            {t.label}
          </label>
        ))}
        <button
          type="button"
          disabled={busy || tiers.length === 0}
          className="btn-primary min-h-11 px-3 text-xs"
          onClick={() =>
            post({ action: "run", tiers }, (j) =>
              `Run ${String(j.stopReason)} — ${Object.entries((j.counts as Record<string, number>) ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ") || "nothing to do"}`,
            )
          }
        >
          {busy ? "Running…" : "Run batch now"}
        </button>
      </fieldset>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          Re-enrich one bottle (id)
          <input
            value={bottleId}
            onChange={(e) => setBottleId(e.target.value)}
            className="w-72 rounded-lg border border-border-subtle bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={busy || !live || bottleId.trim() === ""}
          className="btn-secondary min-h-11 px-3 text-xs"
          onClick={() => post({ action: "reenrich", bottleId: bottleId.trim() }, () => "Queued — open the bottle to watch it")}
        >
          Re-enrich
        </button>
      </div>
      {message && <p role="status" className="text-xs text-muted">{message}</p>}
    </section>
  );
}

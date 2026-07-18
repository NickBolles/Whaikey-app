"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { BarRow } from "@/lib/bar";
import { FillGauge } from "@/components/fill-gauge";

/** BarRow with dates possibly serialized to strings (API JSON responses). */
export type Row = Omit<BarRow, "createdAt" | "updatedAt" | "purchaseDate"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  purchaseDate: Date | string | null;
};

type Tab = "bar" | "wishlist" | "tried";

const TABS: { key: Tab; label: string }[] = [
  { key: "bar", label: "My Bar" },
  { key: "wishlist", label: "Wishlist" },
  { key: "tried", label: "Tried" },
];

const FILL_STEPS = [100, 75, 50, 25, 10];

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function statusChipClass(status: string | null): string {
  switch (status) {
    case "open":
      return "bg-accent/15 text-accent";
    case "sealed":
      return "bg-surface-raised text-muted";
    case "finished":
      return "bg-surface-raised text-muted line-through";
    default:
      return "bg-surface-raised text-muted";
  }
}

export function BarClient({ initialRows }: { initialRows: Row[] }) {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [tab, setTab] = useState<Tab>("bar");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ownRows = useMemo(() => rows.filter((r) => r.relationship === "own"), [rows]);
  const wishlistRows = useMemo(() => rows.filter((r) => r.relationship === "wishlist"), [rows]);
  const triedRows = useMemo(() => rows.filter((r) => r.relationship === "tried"), [rows]);

  const stats = useMemo(() => {
    let totalSpent = 0;
    let estValue = 0;
    let openCount = 0;
    for (const r of ownRows) {
      const qty = r.quantity ?? 1;
      if (r.purchasePrice != null) totalSpent += r.purchasePrice * qty;
      const unit = r.estValue ?? r.bottle.avgPrice;
      if (unit != null) estValue += unit * qty;
      if (r.status === "open") openCount += 1;
    }
    return { bottleCount: ownRows.length, openCount, totalSpent, estValue };
  }, [ownRows]);

  const killList = useMemo(
    () =>
      ownRows
        .filter((r) => r.status === "open" && r.fillLevel != null && r.fillLevel <= 20)
        .sort((a, b) => (a.fillLevel ?? 0) - (b.fillLevel ?? 0)),
    [ownRows],
  );

  function fail(message: string) {
    setError(message);
    setTimeout(() => setError(null), 4000);
  }

  async function patchRow(id: string, patch: Record<string, unknown>) {
    const prev = rows;
    // Optimistic: mirror the server's fill-level rules locally.
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r, ...patch } as Row;
        if (patch.status === "finished") next.fillLevel = 0;
        else if (
          patch.status === "open" &&
          patch.fillLevel === undefined &&
          (r.status === "sealed" || r.status == null)
        )
          next.fillLevel = 100;
        return next;
      }),
    );
    const res = await fetch(`/api/user-bottles/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => null);
    if (!res?.ok) {
      setRows(prev);
      fail("Update failed — try again.");
      return;
    }
    const updated = (await res.json()) as Partial<Row>;
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...updated, bottle: r.bottle } : r)));
  }

  async function removeRow(id: string) {
    const prev = rows;
    setRows((rs) => rs.filter((r) => r.id !== id));
    setExpandedId(null);
    const res = await fetch(`/api/user-bottles/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setRows(prev);
      fail("Remove failed — try again.");
    }
  }

  async function moveToBar(row: Row) {
    const answer = window.prompt("What did you pay for it? (optional, e.g. 59.99)", "");
    if (answer === null) return;
    const price = answer.trim() === "" ? undefined : Number.parseFloat(answer);
    const body: Record<string, unknown> = { bottleId: row.bottleId, relationship: "own" };
    if (price != null && Number.isFinite(price) && price >= 0) {
      body.purchasePrice = price;
      body.purchaseDate = new Date().toISOString();
    }
    const res = await fetch("/api/user-bottles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      fail("Could not move to bar — try again.");
      return;
    }
    const updated = (await res.json()) as Partial<Row>;
    setRows((rs) =>
      rs.map((r) =>
        r.id === row.id
          ? { ...r, ...updated, relationship: "own", status: r.status ?? "sealed", bottle: r.bottle }
          : r,
      ),
    );
    setTab("bar");
  }

  const activeRows = tab === "bar" ? ownRows : tab === "wishlist" ? wishlistRows : triedRows;

  return (
    <div className="px-4 pt-8 pb-24 flex flex-col gap-5">
      <header className="flex items-end justify-between">
        <h1 className="text-2xl font-bold">My Bar</h1>
        <Link href="/search" className="text-sm text-accent hover:underline">
          + Add bottle
        </Link>
      </header>

      <div role="tablist" aria-label="Bar sections" className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
              tab === t.key
                ? "bg-accent text-background"
                : "bg-surface border border-border-subtle text-muted hover:bg-surface-raised"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 text-red-400 text-sm p-3">
          {error}
        </div>
      )}

      {tab === "bar" && (
        <>
          <section aria-label="Bar stats" className="grid grid-cols-2 gap-3">
            <StatCard value={String(stats.bottleCount)} label="bottles" />
            <StatCard value={String(stats.openCount)} label="open" />
            <StatCard value={money(stats.totalSpent)} label="total spent" />
            <StatCard value={money(stats.estValue)} label="est. value" />
          </section>

          {killList.length > 0 && (
            <section
              aria-label="Kill list"
              className="rounded-xl border border-accent/40 bg-accent/10 p-4"
            >
              <h2 className="text-sm font-semibold text-accent">Finish these first</h2>
              <ul className="mt-1 text-sm text-muted">
                {killList.map((r) => (
                  <li key={r.id}>
                    {r.bottle.name} — {r.fillLevel}% left
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {activeRows.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <ul className="flex flex-col gap-2">
          {activeRows.map((row) => (
            <li
              key={row.id}
              className="rounded-xl bg-surface border border-border-subtle overflow-hidden"
            >
              {tab === "bar" ? (
                <>
                  <button
                    className="w-full flex items-center gap-3 p-3 text-left hover:bg-surface-raised transition-colors"
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    aria-expanded={expandedId === row.id}
                  >
                    <FillGauge level={row.fillLevel} className="h-10 w-4 shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium truncate">{row.bottle.name}</span>
                      <span className="block text-xs text-muted truncate">
                        {row.bottle.distilleryName ?? row.bottle.category}
                        {row.quantity > 1 ? ` · ×${row.quantity}` : ""}
                      </span>
                    </span>
                    {row.status && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusChipClass(row.status)}`}
                      >
                        {row.status}
                      </span>
                    )}
                    <span className="text-sm text-muted w-16 text-right">
                      {row.purchasePrice != null ? `$${row.purchasePrice.toFixed(0)}` : "—"}
                    </span>
                  </button>
                  {expandedId === row.id && (
                    <RowDetails
                      key={row.id}
                      row={row}
                      onPatch={(patch) => patchRow(row.id, patch)}
                      onRemove={() => removeRow(row.id)}
                    />
                  )}
                </>
              ) : (
                <div className="flex items-center gap-3 p-3">
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium truncate">{row.bottle.name}</span>
                    <span className="block text-xs text-muted truncate">
                      {row.bottle.distilleryName ?? row.bottle.category}
                    </span>
                  </span>
                  {tab === "wishlist" ? (
                    <>
                      <span className="text-sm text-muted">
                        {row.bottle.avgPrice != null ? `~$${row.bottle.avgPrice.toFixed(0)}` : ""}
                      </span>
                      <button
                        onClick={() => moveToBar(row)}
                        className="rounded-xl bg-accent text-background text-sm font-semibold px-3 py-1.5 hover:bg-accent-deep transition-colors"
                      >
                        Move to bar
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-muted capitalize">{row.bottle.category}</span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-surface border border-border-subtle p-4">
      <div className="text-2xl font-bold text-accent">{value}</div>
      <div className="text-xs text-muted mt-1">{label}</div>
    </div>
  );
}

function EmptyState({ tab }: { tab: Tab }) {
  const copy =
    tab === "bar"
      ? "No bottles on your shelf yet."
      : tab === "wishlist"
        ? "Nothing on your wishlist yet."
        : "No tried bottles logged yet.";
  return (
    <div className="rounded-xl bg-surface border border-border-subtle p-8 text-center flex flex-col items-center gap-3">
      <div className="text-3xl">🥃</div>
      <p className="text-muted text-sm">{copy}</p>
      <Link href="/search" className="text-accent text-sm font-semibold hover:underline">
        Find a bottle →
      </Link>
    </div>
  );
}

function RowDetails({
  row,
  onPatch,
  onRemove,
}: {
  row: Row;
  onPatch: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const [price, setPrice] = useState(row.purchasePrice?.toString() ?? "");
  const [store, setStore] = useState(row.store ?? "");
  const [location, setLocation] = useState(row.location ?? "");

  function saveDetails() {
    const parsed = price.trim() === "" ? null : Number.parseFloat(price);
    onPatch({
      purchasePrice: parsed != null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
      store: store.trim() === "" ? null : store.trim(),
      location: location.trim() === "" ? null : location.trim(),
    });
  }

  const inputClass =
    "rounded-lg bg-surface-raised border border-border-subtle px-2 py-1.5 text-sm w-full";

  return (
    <div className="border-t border-border-subtle p-3 flex flex-col gap-3 bg-surface-raised/40">
      <div className="flex flex-wrap gap-2">
        {row.status !== "open" && row.status !== "finished" && (
          <button
            onClick={() => onPatch({ status: "open" })}
            className="rounded-xl bg-accent text-background text-sm font-semibold px-3 py-1.5 hover:bg-accent-deep transition-colors"
          >
            Mark open
          </button>
        )}
        {row.status !== "finished" && (
          <button
            onClick={() => onPatch({ status: "finished" })}
            className="rounded-xl bg-surface border border-border-subtle text-sm px-3 py-1.5 hover:bg-surface-raised transition-colors"
          >
            Mark finished
          </button>
        )}
        <button
          onClick={onRemove}
          className="rounded-xl border border-red-500/40 text-red-400 text-sm px-3 py-1.5 hover:bg-red-500/10 transition-colors ml-auto"
        >
          Remove
        </button>
      </div>

      {row.status === "open" && (
        <div>
          <div className="text-xs text-muted mb-1">Fill level</div>
          <div className="flex gap-2">
            {FILL_STEPS.map((step) => (
              <button
                key={step}
                onClick={() => onPatch({ fillLevel: step })}
                aria-pressed={row.fillLevel === step}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                  row.fillLevel === step
                    ? "bg-accent text-background"
                    : "bg-surface border border-border-subtle text-muted hover:bg-surface-raised"
                }`}
              >
                {step}%
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 items-end">
        <label className="text-xs text-muted flex flex-col gap-1">
          Paid ($)
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            className={inputClass}
            placeholder="59.99"
          />
        </label>
        <label className="text-xs text-muted flex flex-col gap-1">
          Store
          <input
            value={store}
            onChange={(e) => setStore(e.target.value)}
            className={inputClass}
            placeholder="Store"
          />
        </label>
        <label className="text-xs text-muted flex flex-col gap-1">
          Location
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className={inputClass}
            placeholder="Shelf A"
          />
        </label>
      </div>
      <button
        onClick={saveDetails}
        className="self-start rounded-xl bg-surface border border-border-subtle text-sm font-semibold px-4 py-1.5 hover:bg-surface-raised transition-colors"
      >
        Save details
      </button>
    </div>
  );
}

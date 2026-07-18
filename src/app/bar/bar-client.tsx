"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Hourglass, Plus } from "lucide-react";
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
      return "chip-active";
    case "finished":
      return "line-through opacity-70";
    default:
      return "";
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
    <div className="px-4 pt-5 pb-10 flex flex-col gap-6">
      <header className="flex items-end justify-between">
        <h1 className="font-display text-[2rem] leading-tight font-semibold">My Bar</h1>
        <Link
          href="/search"
          className="inline-flex items-center gap-1 min-h-11 px-1 text-sm font-medium text-accent hover:underline"
        >
          <Plus size={16} strokeWidth={1.8} aria-hidden /> Add bottle
        </Link>
      </header>

      <div role="tablist" aria-label="Bar sections" className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`chip inline-flex items-center min-h-11 px-4 text-sm font-medium ${
              tab === t.key ? "chip-active" : "hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 text-danger text-sm p-3">
          {error}
        </div>
      )}

      {tab === "bar" && (
        <>
          <section aria-label="Bar stats" className="grid grid-cols-4 gap-2">
            <StatCard value={String(stats.bottleCount)} label="bottles" />
            <StatCard value={String(stats.openCount)} label="open" />
            <StatCard value={money(stats.totalSpent)} label="spent" />
            <StatCard value={money(stats.estValue)} label="est. value" />
          </section>

          {killList.length > 0 && (
            <section
              aria-label="Kill list"
              className="rounded-2xl border border-accent/25 bg-accent/[0.07] p-4"
            >
              <h2 className="flex items-center gap-2 text-sm font-semibold text-accent">
                <Hourglass size={18} strokeWidth={1.8} aria-hidden />
                Finish these first
              </h2>
              <ul className="mt-2.5 flex flex-col gap-1.5 text-sm">
                {killList.map((r) => (
                  <li key={r.id} className="flex items-baseline justify-between gap-3">
                    <span className="truncate font-medium text-foreground/90">{r.bottle.name}</span>
                    <span className="shrink-0 text-muted">
                      <span className="stat-number text-accent">{r.fillLevel}%</span> left
                    </span>
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
        <ul className="flex flex-col gap-2.5">
          {activeRows.map((row) => (
            <li key={row.id} className="card-flat overflow-hidden">
              {tab === "bar" ? (
                <>
                  <button
                    className="w-full flex items-center gap-3.5 p-4 text-left hover:bg-surface-raised transition-colors"
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    aria-expanded={expandedId === row.id}
                  >
                    <FillGauge level={row.fillLevel} className="h-12 w-5 shrink-0 text-muted" />
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium leading-snug line-clamp-2">
                        {row.bottle.name}
                      </span>
                      <span className="block text-xs text-muted truncate mt-0.5">
                        {row.bottle.distilleryName ?? row.bottle.category}
                        {row.quantity > 1 ? ` · ×${row.quantity}` : ""}
                      </span>
                    </span>
                    <span className="flex flex-col items-end gap-1.5 shrink-0">
                      <span
                        className={`stat-number text-lg leading-none ${
                          row.purchasePrice != null ? "" : "text-muted"
                        }`}
                      >
                        {row.purchasePrice != null ? `$${row.purchasePrice.toFixed(0)}` : "—"}
                      </span>
                      {row.status && (
                        <span
                          className={`chip px-2 py-0.5 text-[10px] font-medium ${statusChipClass(row.status)}`}
                        >
                          {row.status}
                        </span>
                      )}
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
                <div className="flex items-center gap-3.5 p-4">
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium leading-snug line-clamp-2">
                      {row.bottle.name}
                    </span>
                    <span className="block text-xs text-muted truncate mt-0.5">
                      {row.bottle.distilleryName ?? row.bottle.category}
                    </span>
                  </span>
                  {tab === "wishlist" ? (
                    <span className="flex flex-col items-end gap-1.5 shrink-0">
                      {row.bottle.avgPrice != null && (
                        <span className="text-muted text-sm">
                          ~<span className="stat-number">${row.bottle.avgPrice.toFixed(0)}</span>
                        </span>
                      )}
                      <button
                        onClick={() => moveToBar(row)}
                        className="btn-primary text-[13px] px-3.5 py-2"
                      >
                        Move to bar
                      </button>
                    </span>
                  ) : (
                    <span className="chip px-2.5 py-1 text-[11px] capitalize shrink-0">
                      {row.bottle.category}
                    </span>
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
    <div className="card p-3">
      <div className="stat-number text-[1.35rem] leading-none text-accent">{value}</div>
      <div className="text-[10px] text-muted mt-2">{label}</div>
    </div>
  );
}

function EmptyState({ tab }: { tab: Tab }) {
  const copy =
    tab === "bar"
      ? {
          title: "Your shelf is waiting",
          line: "Find a bottle you love and add it to your bar.",
          action: "Find a bottle",
        }
      : tab === "wishlist"
        ? {
            title: "Nothing wished for yet",
            line: "Save bottles you're hunting and track their going price.",
            action: "Browse bottles",
          }
        : {
            title: "No tastings logged",
            line: "Bottles you've tried — at a bar, a friend's, a festival — live here.",
            action: "Find a bottle",
          };
  return (
    <div className="card p-8 text-center flex flex-col items-center gap-3">
      <div aria-hidden className="text-4xl">
        🥃
      </div>
      <p className="font-display text-lg font-semibold">{copy.title}</p>
      <p className="text-sm text-muted max-w-[26ch] leading-relaxed">{copy.line}</p>
      <Link href="/search" className="btn-secondary px-5 py-2.5 text-sm font-medium mt-1">
        {copy.action}
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
    "rounded-xl bg-surface-raised/70 border border-border-subtle px-3 py-2.5 text-sm w-full";

  return (
    <div className="border-t border-border-subtle p-4 flex flex-col gap-4 bg-surface-raised/30">
      <div className="flex flex-wrap items-center gap-2">
        {row.status !== "open" && row.status !== "finished" && (
          <button
            onClick={() => onPatch({ status: "open" })}
            className="btn-secondary min-h-11 px-4 text-sm font-medium"
          >
            Mark open
          </button>
        )}
        {row.status !== "finished" && (
          <button
            onClick={() => onPatch({ status: "finished" })}
            className="btn-secondary min-h-11 px-4 text-sm font-medium"
          >
            Mark finished
          </button>
        )}
        <button
          onClick={onRemove}
          className="ml-auto min-h-11 px-2 text-sm text-danger hover:underline"
        >
          Remove
        </button>
      </div>

      {row.status === "open" && (
        <div>
          <div className="section-label mb-2">
            Fill level{row.fillLevel != null ? ` · ${row.fillLevel}%` : ""}
          </div>
          <div className="flex flex-wrap gap-2">
            {FILL_STEPS.map((step) => (
              <button
                key={step}
                onClick={() => onPatch({ fillLevel: step })}
                aria-pressed={row.fillLevel === step}
                className={`chip inline-flex items-center min-h-11 px-3.5 text-[13px] font-medium ${
                  row.fillLevel === step ? "chip-active" : "hover:text-foreground"
                }`}
              >
                {step}%
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 items-end">
        <label className="text-xs text-muted flex flex-col gap-1.5">
          Paid ($)
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            className={inputClass}
            placeholder="59.99"
          />
        </label>
        <label className="text-xs text-muted flex flex-col gap-1.5">
          Store
          <input
            value={store}
            onChange={(e) => setStore(e.target.value)}
            className={inputClass}
            placeholder="Store"
          />
        </label>
        <label className="text-xs text-muted flex flex-col gap-1.5">
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
        className="btn-secondary self-start min-h-11 px-4 text-sm font-medium"
      >
        Save details
      </button>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BottleStatus } from "@/db/schema";

const FILL_STEPS = [100, 75, 50, 25, 10];

export interface ShelfDetailsRow {
  id: string;
  status: BottleStatus | null;
  fillLevel: number | null;
  purchasePrice: number | null;
  store: string | null;
  location: string | null;
  notes: string | null;
}

/**
 * Owner-only editing for the shelf row: status, fill level, purchase details
 * and removal. This used to live inside the My Bar list rows; those are now a
 * single tap target to this page, so the editing lives with the bottle.
 */
export function ShelfDetails({ row }: { row: ShelfDetailsRow }) {
  const router = useRouter();
  const [price, setPrice] = useState(row.purchasePrice?.toString() ?? "");
  const [store, setStore] = useState(row.store ?? "");
  const [location, setLocation] = useState(row.location ?? "");
  const [notes, setNotes] = useState(row.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/user-bottles/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError("Update failed — try again.");
      return;
    }
    router.refresh();
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/user-bottles/${row.id}`, { method: "DELETE" }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError("Remove failed — try again.");
      return;
    }
    router.refresh();
  }

  function saveDetails() {
    const parsed = price.trim() === "" ? null : Number.parseFloat(price);
    void patch({
      purchasePrice: parsed != null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
      store: store.trim() === "" ? null : store.trim(),
      location: location.trim() === "" ? null : location.trim(),
      notes: notes.trim() === "" ? null : notes.trim(),
    });
  }

  const inputClass =
    "rounded-xl bg-surface-raised/70 border border-border-subtle px-3 py-2.5 text-sm w-full";

  return (
    <div className="flex flex-col gap-4 border-t border-border-subtle pt-4">
      <div className="flex flex-wrap items-center gap-2">
        {row.status !== "open" && row.status !== "finished" && (
          <button
            onClick={() => patch({ status: "open" })}
            disabled={busy}
            className="btn-secondary min-h-11 px-4 text-sm font-medium disabled:opacity-60"
          >
            Mark open
          </button>
        )}
        {row.status !== "finished" && (
          <button
            onClick={() => patch({ status: "finished" })}
            disabled={busy}
            className="btn-secondary min-h-11 px-4 text-sm font-medium disabled:opacity-60"
          >
            Mark finished
          </button>
        )}
        <button
          onClick={remove}
          disabled={busy}
          className="ml-auto min-h-11 px-2 text-sm text-danger hover:underline disabled:opacity-60"
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
                onClick={() => patch({ fillLevel: step })}
                disabled={busy}
                aria-pressed={row.fillLevel === step}
                className={`chip inline-flex items-center min-h-11 px-3.5 text-[13px] font-medium disabled:opacity-60 ${
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

      <label className="text-xs text-muted flex flex-col gap-1.5">
        Your notes
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className={`${inputClass} resize-y min-h-[44px]`}
          placeholder="Great with a drop of water…"
        />
      </label>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      <div>
        <button
          onClick={saveDetails}
          disabled={busy}
          className="btn-secondary min-h-11 px-4 text-sm font-medium disabled:opacity-60"
        >
          Save details
        </button>
      </div>
    </div>
  );
}

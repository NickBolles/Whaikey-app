"use client";

import { useState } from "react";
import type { PourVisibility } from "@/db/schema";
import { VISIBILITY_META, VisibilityChips } from "./visibility-chips";

/**
 * History-row visibility badge (docs/SOCIAL.md §6.2 "/history — per-pour
 * visibility badge + change control"). Renders the current tier as a small
 * muted chip; tapping it expands the 4-option row. Changing the value PATCHes
 * /api/pours/[id] optimistically and reverts if the request fails.
 */
export function VisibilityControl({
  pourId,
  visibility,
  onChange,
}: {
  pourId: string;
  visibility: PourVisibility;
  onChange?: (next: PourVisibility) => void;
}) {
  const [value, setValue] = useState(visibility);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const { label, icon: Icon } = VISIBILITY_META[value];

  async function apply(next: PourVisibility) {
    setOpen(false);
    if (next === value) return;
    const previous = value;
    setValue(next);
    setError(false);
    setSaving(true);
    try {
      const res = await fetch(`/api/pours/${pourId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      if (!res.ok) throw new Error("visibility update failed");
      onChange?.(next);
    } catch {
      setValue(previous);
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={saving}
        className="chip flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted hover:text-foreground transition-colors disabled:opacity-60"
      >
        <Icon size={12} strokeWidth={1.8} aria-hidden />
        {label}
      </button>

      {open && <VisibilityChips value={value} onChange={apply} disabled={saving} idPrefix={`vis-${pourId}`} />}

      {error && (
        <p role="alert" className="text-xs text-danger">
          Couldn&apos;t update visibility — try again.
        </p>
      )}
    </div>
  );
}

"use client";

import { Globe, Lock, Users, Users2, type LucideIcon } from "lucide-react";
import { POUR_VISIBILITIES, type PourVisibility } from "@/db/schema";

/**
 * Shared copy + iconography for the 4 pour visibility tiers (US-6, history
 * badges). One source so the pour sheet, history rows, and any future
 * surface never drift on labels.
 */
export const VISIBILITY_META: Record<PourVisibility, { label: string; icon: LucideIcon }> = {
  private: { label: "Only me", icon: Lock },
  friends: { label: "Friends", icon: Users },
  followers: { label: "Followers", icon: Users2 },
  public: { label: "Public", icon: Globe },
};

/** A row of the 4 visibility chips — purely controlled, no fetching. */
export function VisibilityChips({
  value,
  onChange,
  disabled = false,
  idPrefix = "visibility",
}: {
  value: PourVisibility;
  onChange: (next: PourVisibility) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Who can see this">
      {POUR_VISIBILITIES.map((option) => {
        const { label, icon: Icon } = VISIBILITY_META[option];
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            id={`${idPrefix}-${option}`}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option)}
            className={`chip min-h-11 flex items-center gap-1.5 px-3.5 text-sm ${
              active ? "chip-active font-medium" : "hover:bg-surface-raised"
            } disabled:opacity-60`}
          >
            <Icon size={14} strokeWidth={1.8} aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}

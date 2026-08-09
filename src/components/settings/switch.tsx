"use client";

/**
 * The one toggle used across the notification settings screen.
 *
 * A `role="switch"` button rather than a checkbox: the control is 44px of hit
 * area around a 20px track (docs/DESIGN.md rule 8), and a native checkbox
 * styled to look like this ends up fighting its own rendering on every
 * platform. Screen readers get the same semantics either way.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name; visually the caller renders its own text beside this. */
  label: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`tap-target relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        disabled
          ? "cursor-not-allowed border-border bg-surface opacity-50"
          : checked
            ? "border-accent/60 bg-accent/80"
            : "border-border bg-surface"
      }`}
    >
      <span
        aria-hidden
        className={`pointer-events-none block h-4 w-4 rounded-full transition-transform duration-150 ${
          checked ? "translate-x-6 bg-background" : "translate-x-1 bg-muted"
        }`}
      />
    </button>
  );
}

/**
 * A labelled row wrapping a Switch — label, one muted line, control on the
 * right. Used for both account categories and per-device overrides.
 */
export function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled = false,
  /** Rendered between the description and the switch, e.g. "Always on". */
  badge,
  /** Rendered under the description, e.g. the "Reset to account" action. */
  footer,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  badge?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p id={descriptionId} className="mt-0.5 text-xs leading-relaxed text-muted">
            {description}
          </p>
        )}
        {footer}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {badge}
        <Switch
          checked={checked}
          onChange={onChange}
          label={label}
          disabled={disabled}
          describedBy={descriptionId}
        />
      </div>
    </div>
  );
}

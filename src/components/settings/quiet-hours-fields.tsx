"use client";

import { useMemo, useSyncExternalStore } from "react";

/**
 * Start / end / zone, shared by the account default and every per-device
 * override so the two never drift apart in behaviour or in look.
 *
 * The zone is part of the control, not a hidden global. Per-device quiet hours
 * are worth nothing if a laptop in Denver and a phone in Lisbon both resolve
 * "22:00" against one account-wide zone, and the failure would be silent —
 * notifications simply arriving four hours off.
 */
export function QuietHoursFields({
  idPrefix,
  start,
  end,
  timeZone,
  onChange,
  disabled = false,
}: {
  idPrefix: string;
  start: string;
  end: string;
  timeZone: string;
  onChange: (patch: { start?: string; end?: string; timeZone?: string }) => void;
  disabled?: boolean;
}) {
  const zones = useTimeZones();
  const localZone = useLocalTimeZone();

  return (
    // Labels sit beside their controls rather than wrapping them: a <label>
    // that wraps a <select> pulls every <option> into the control's accessible
    // name, so this one announced as "Time zone Africa/Abidjan Africa/Accra …"
    // to a screen reader.
    <div className="mt-3 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted" htmlFor={`${idPrefix}-start`}>
            Start
          </label>
          <input
            id={`${idPrefix}-start`}
            type="time"
            value={start}
            disabled={disabled}
            onChange={(e) => onChange({ start: e.target.value })}
            className="rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted" htmlFor={`${idPrefix}-end`}>
            End
          </label>
          <input
            id={`${idPrefix}-end`}
            type="time"
            value={end}
            disabled={disabled}
            onChange={(e) => onChange({ end: e.target.value })}
            className="rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none disabled:opacity-50"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-muted" htmlFor={`${idPrefix}-zone`}>
          Time zone
        </label>
        <select
          id={`${idPrefix}-zone`}
          value={timeZone}
          disabled={disabled}
          onChange={(e) => onChange({ timeZone: e.target.value })}
          className="rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none disabled:opacity-50"
        >
          {/* A stored zone the runtime does not enumerate must still be
              selectable, or opening the form would silently rewrite it. */}
          {!zones.includes(timeZone) && <option value={timeZone}>{timeZone}</option>}
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      {localZone !== null && timeZone !== localZone && !disabled && (
        <button
          type="button"
          onClick={() => onChange({ timeZone: localZone })}
          className="self-start text-xs text-accent underline decoration-dotted underline-offset-4"
        >
          Use this device&rsquo;s zone ({localZone.replace(/_/g, " ")})
        </button>
      )}
    </div>
  );
}

/**
 * The viewer's own zone, resolved after mount.
 *
 * The server's zone is whatever the host happens to run in — usually UTC — and
 * the browser's is the user's. Reading it during the first render would make
 * the shortcut below appear on the server and vanish on the client (or the
 * reverse), which is a hydration mismatch; null until mounted keeps both
 * renders identical.
 */
function useLocalTimeZone(): string | null {
  return useSyncExternalStore(
    // The zone never changes under us, so there is nothing to subscribe to;
    // this hook is here for its server snapshot, which is what keeps the two
    // renders in agreement.
    NO_SUBSCRIPTION,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null,
  );
}

const NO_SUBSCRIPTION = () => () => {};

/**
 * Every IANA zone the runtime knows, or a short fallback list. `supportedValuesOf`
 * is not in older Safari, and an empty zone picker would strand the user on
 * whatever zone happened to be stored.
 */
function useTimeZones(): string[] {
  return useMemo(() => {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;
    if (typeof supported === "function") {
      try {
        return supported("timeZone");
      } catch {
        // fall through
      }
    }
    return [
      "UTC",
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "Europe/London",
      "Europe/Berlin",
      "Europe/Lisbon",
      "Asia/Tokyo",
      "Australia/Sydney",
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ].filter((zone, index, all) => all.indexOf(zone) === index);
  }, []);
}

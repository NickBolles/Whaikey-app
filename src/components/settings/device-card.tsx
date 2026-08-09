"use client";

import { useState } from "react";
import { Check, ChevronDown, Globe, Loader2, Pencil, Send, Smartphone, Trash2, X } from "lucide-react";
import type { DevicePatch } from "@/lib/notifications/registry";
import type { AccountQuietHoursView, DeviceView } from "@/lib/notifications/view";
import type { DeviceOutcome } from "@/lib/notifications/deliver";
import { HealthChip } from "./health-banner";
import { QuietHoursFields } from "./quiet-hours-fields";
import { SwitchRow } from "./switch";

const QUIET_MODES = [
  { value: "inherit", label: "Follow account" },
  { value: "off", label: "Always allow" },
  { value: "custom", label: "Custom" },
] as const;

/**
 * One registered device, and everything that can be true of it.
 *
 * The card is deliberately self-contained: a device's health, its own quiet
 * window, its category overrides and the button that proves whether it works
 * all sit in one place, because they are all answers to a single question the
 * user is asking about a single piece of hardware. Splitting them across
 * sections is what made the old shape hard to reason about.
 */
export function DeviceCard({
  device,
  isCurrent,
  accountQuietHours,
  busy,
  testResult,
  onPatch,
  onTest,
  onRemove,
}: {
  device: DeviceView;
  isCurrent: boolean;
  accountQuietHours: AccountQuietHoursView;
  busy: boolean;
  testResult: DeviceOutcome | null;
  onPatch: (patch: DevicePatch) => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(device.name);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const PlatformIcon = device.platform === "web" ? Globe : Smartphone;
  const quiet = device.quietHours;

  // A device that already differs from the account opens showing how, so an
  // exception is never hidden behind a chevron the user has no reason to click.
  const overrideCount = device.categories.filter((c) => c.source === "device").length;
  const [typesOpen, setTypesOpen] = useState(overrideCount > 0);

  const commitName = () => {
    setEditingName(false);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== device.name) onPatch({ label: trimmed });
    else setDraftName(device.name);
  };

  return (
    // Changes round-trip before they show, so the card marks itself busy
    // instead of leaving a tapped control looking inert. Deliberately not
    // optimistic: this screen's job is to show what the server will do.
    <article
      id={`device-${device.id}`}
      aria-busy={busy}
      className={`card p-5 scroll-mt-4 transition-opacity duration-150 ${busy ? "opacity-70" : ""}`}
    >
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <PlatformIcon size={18} strokeWidth={1.8} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            {editingName ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={draftName}
                  maxLength={60}
                  aria-label="Device name"
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitName();
                    if (e.key === "Escape") {
                      setDraftName(device.name);
                      setEditingName(false);
                    }
                  }}
                  className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-2.5 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none"
                />
                <button
                  type="button"
                  onClick={commitName}
                  aria-label="Save device name"
                  className="tap-target rounded-lg p-1 text-accent"
                >
                  <Check size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraftName(device.name);
                    setEditingName(false);
                  }}
                  aria-label="Cancel renaming"
                  className="tap-target rounded-lg p-1 text-muted"
                >
                  <X size={16} aria-hidden />
                </button>
              </div>
            ) : (
              // The chip rides in the name's own wrapping row: a long one
              // ("Server not configured") then drops to its own line instead of
              // squeezing the device name to two words per line.
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <h3 className="font-display text-base font-semibold">{device.name}</h3>
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  aria-label={`Rename ${device.name}`}
                  className="tap-target rounded-lg p-0.5 text-muted hover:text-foreground"
                >
                  <Pencil size={13} aria-hidden />
                </button>
                {isCurrent && <span className="chip chip-active">This device</span>}
                <HealthChip severity={device.health.severity}>{device.health.headline}</HealthChip>
              </div>
            )}
            <p className="mt-1 text-xs leading-relaxed text-muted">{device.health.detail}</p>
            {device.health.fix && (
              <p className="mt-0.5 text-xs leading-relaxed text-accent/90">{device.health.fix}</p>
            )}
          </div>
        </div>
      </header>

      <div className="mt-4 border-t border-border-subtle">
        <SwitchRow
          id={`${device.id}-enabled`}
          label="Receive notifications here"
          description={
            device.enabled
              ? "This device is included when something is sent."
              : "Nothing is sent to this device while it's off."
          }
          checked={device.enabled}
          onChange={(next) => onPatch({ enabled: next })}
        />
      </div>

      <section aria-label={`Quiet hours for ${device.name}`} className="mt-2 border-t border-border-subtle pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <h4 className="section-label">Quiet hours</h4>
          {quiet.effective.activeNow && (
            <span className="text-[11px] text-accent">Holding now</span>
          )}
        </div>

        <div role="radiogroup" aria-label={`Quiet hours mode for ${device.name}`} className="mt-2 flex flex-wrap gap-2">
          {QUIET_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={quiet.mode === mode.value}
              onClick={() =>
                onPatch(
                  mode.value === "custom"
                    ? {
                        quietHoursMode: "custom",
                        // Seed a custom window from the account default so the
                        // first click produces a valid, obvious starting point
                        // rather than an empty form.
                        quietStart: quiet.start ?? accountQuietHours.start,
                        quietEnd: quiet.end ?? accountQuietHours.end,
                        timeZone:
                          quiet.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
                      }
                    : { quietHoursMode: mode.value },
                )
              }
              className={`chip tap-target ${quiet.mode === mode.value ? "chip-active" : ""}`}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {quiet.mode === "custom" ? (
          <QuietHoursFields
            idPrefix={`device-${device.id}`}
            start={quiet.start ?? accountQuietHours.start}
            end={quiet.end ?? accountQuietHours.end}
            timeZone={quiet.timeZone ?? accountQuietHours.timeZone}
            onChange={(patch) =>
              onPatch({
                quietHoursMode: "custom",
                quietStart: patch.start ?? quiet.start ?? accountQuietHours.start,
                quietEnd: patch.end ?? quiet.end ?? accountQuietHours.end,
                timeZone: patch.timeZone ?? quiet.timeZone ?? accountQuietHours.timeZone,
              })
            }
          />
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {quiet.mode === "off"
              ? "Notifications reach this device at any hour."
              : accountQuietHours.enabled
                ? `Following your account setting: ${accountQuietHours.description} (${accountQuietHours.timeZone.replace(/_/g, " ")}).`
                : "Your account has quiet hours off, so nothing is held back here."}
          </p>
        )}
      </section>

      <section aria-label={`Notification types for ${device.name}`} className="mt-4 border-t border-border-subtle pt-4">
        {/*
          Collapsed unless this device actually differs from the account.
          Repeating the same five toggles per device buried the exceptions in
          noise and made the screen read as a wall of switches; the summary
          states the answer, and opening it is only necessary to change one.
        */}
        <button
          type="button"
          aria-expanded={typesOpen}
          aria-controls={`${device.id}-types`}
          onClick={() => setTypesOpen((open) => !open)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span>
            <span className="section-label block">Types on this device</span>
            <span className="mt-1 block text-xs text-muted">
              {overrideCount === 0
                ? "Following your account defaults"
                : `${overrideCount} changed for this device`}
            </span>
          </span>
          <ChevronDown
            size={18}
            strokeWidth={1.8}
            aria-hidden
            className={`shrink-0 text-muted transition-transform duration-150 ${typesOpen ? "rotate-180" : ""}`}
          />
        </button>

        {typesOpen && (
          <div id={`${device.id}-types`} className="mt-1 divide-y divide-border-subtle">
            {device.categories.map((category) => (
              <SwitchRow
                key={category.id}
                id={`${device.id}-${category.id}`}
                label={category.label}
                description={
                  category.source === "device"
                    ? `Set for this device (account default: ${category.enabled ? "off" : "on"})`
                    : "Following your account default"
                }
                checked={category.enabled}
                onChange={(next) => onPatch({ categoryOverrides: { [category.id]: next } })}
                footer={
                  category.source === "device" ? (
                    <button
                      type="button"
                      onClick={() => onPatch({ categoryOverrides: { [category.id]: null } })}
                      className="mt-1 text-[11px] text-accent underline decoration-dotted underline-offset-4"
                    >
                      Reset to account default
                    </button>
                  ) : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      <footer className="mt-4 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
        <button
          type="button"
          onClick={onTest}
          disabled={busy}
          className="btn-secondary flex items-center gap-2 px-3.5 py-2.5 text-sm disabled:opacity-60"
        >
          {busy ? (
            <Loader2 size={15} className="animate-spin" aria-hidden />
          ) : (
            <Send size={15} aria-hidden />
          )}
          Send test
        </button>

        {confirmRemove ? (
          <span className="flex items-center gap-2 text-sm">
            <span className="text-muted">Remove?</span>
            <button
              type="button"
              onClick={() => {
                setConfirmRemove(false);
                onRemove();
              }}
              className="rounded-xl border border-danger/50 px-3 py-2 text-sm text-danger"
            >
              Yes, remove
            </button>
            <button type="button" onClick={() => setConfirmRemove(false)} className="text-sm text-muted">
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-muted hover:text-danger"
          >
            <Trash2 size={15} aria-hidden />
            Remove
          </button>
        )}
      </footer>

      {testResult && (
        <p
          role="status"
          className={`mt-3 rounded-xl border px-3 py-2.5 text-xs leading-relaxed ${
            testResult.status === "delivered"
              ? "border-success/40 bg-success/10 text-success"
              : testResult.status === "failed" || testResult.status === "not_configured"
                ? "border-danger/40 bg-danger/10 text-danger"
                : "border-accent/40 bg-accent/10 text-accent"
          }`}
        >
          {testResult.status === "delivered"
            ? "Test sent. If nothing appears within a few seconds, check your system notification settings for Whaikey."
            : `Not sent — ${testResult.detail ?? testResult.status}`}
        </p>
      )}
    </article>
  );
}

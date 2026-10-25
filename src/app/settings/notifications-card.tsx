"use client";

import { useEffect, useState } from "react";
import { isNativeApp } from "@/lib/native/platform";
import { disablePush, enablePush, pushPermissionState } from "@/lib/native/push";
import { NOTIFICATION_GROUPS } from "@/lib/notify/copy";

/**
 * Settings → Notifications (docs/SOCIAL.md D18).
 *
 * A switch per group decides whether that kind of notification exists at all
 * (inbox and push). The push switch and quiet hours decide only whether a
 * phone buzzes — inside quiet hours a notification goes to the inbox and is
 * never re-sent later. What notifications will never be is stated, not just
 * implied: no nudges to pour, no reminders, no streaks.
 */
export interface NotificationSettingsJson {
  groups: Record<string, boolean>;
  pushEnabled: boolean;
  quietStart: number | null;
  quietEnd: number | null;
  timeZone: string | null;
}

const toTime = (m: number | null) =>
  m == null ? "" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fromTime = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

const TIME_INPUT = "rounded-lg border border-border-subtle bg-surface px-2 py-1 text-foreground";

export function NotificationsCard({
  initial,
  pushAvailable,
}: {
  initial: NotificationSettingsJson;
  /** The deployment has push credentials; when false everything is inbox-only. */
  pushAvailable: boolean;
}) {
  const [settings, setSettings] = useState(initial);
  const [registered, setRegistered] = useState(false);
  const [native, setNative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isNativeApp()) return;
    let live = true;
    void pushPermissionState().then((state) => {
      if (!live) return;
      setNative(true);
      setRegistered(state === "granted");
    });
    return () => {
      live = false;
    };
  }, []);

  const [saving, setSaving] = useState(false);

  /**
   * One save at a time. Each response replaces the whole settings object, so
   * two in flight could land out of order and quietly undo the newer switch;
   * the controls are disabled until the server has answered.
   */
  async function save(patch: Partial<NotificationSettingsJson>) {
    if (saving) return;
    setSaving(true);
    const previous = settings;
    setSettings({ ...settings, ...patch, groups: { ...settings.groups, ...(patch.groups ?? {}) } });
    setMessage(null);
    try {
      const res = await fetch("/api/notifications/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(String(res.status));
      setSettings((await res.json()) as NotificationSettingsJson);
    } catch {
      setSettings(previous);
      setMessage("Couldn't save that — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleEnable() {
    if (busy) return;
    setBusy(true);
    const state = await enablePush().catch(() => "unavailable" as const);
    setBusy(false);
    setRegistered(state === "granted");
    if (state === "denied") setMessage("Notifications are off for Whaikey in your phone's settings.");
  }

  async function handleRelease() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const released = await disablePush().catch(() => false);
    setBusy(false);
    if (released) {
      setRegistered(false);
      setMessage(
        "This device is no longer registered. To stop the app asking again, turn notifications off in your phone's settings.",
      );
    } else {
      setMessage("Couldn't reach the server — this device is still registered. Try again.");
    }
  }

  const quietOn = settings.quietStart != null && settings.quietEnd != null;

  const releaseButton = (
    <button
      type="button"
      onClick={() => void handleRelease()}
      disabled={busy}
      className="btn-secondary tap-target w-fit min-h-11 px-4 text-sm disabled:opacity-60"
    >
      {busy ? "Working…" : "Unregister this device"}
    </button>
  );

  return (
    <section
      id="notifications"
      aria-labelledby="notifications-heading"
      className="card flex scroll-mt-20 flex-col gap-3 p-4"
    >
      <div>
        <p className="section-label">Notifications</p>
        <h2 id="notifications-heading" className="mt-1 font-display text-xl font-semibold">
          What reaches you
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Only things people do with you — never a nudge to pour, a reminder or a streak.
          {!pushAvailable && " Everything lands in your inbox on the Friends tab for now."}
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-border-subtle">
        {NOTIFICATION_GROUPS.map((group) => {
          const on = settings.groups[group.key] ?? group.defaultOn;
          return (
            <li key={group.key} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block text-sm">{group.label}</span>
                <span className="block text-xs text-muted">{group.description}</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={group.label}
                disabled={saving}
                onClick={() => void save({ groups: { [group.key]: !on } })}
                className="tap-target flex min-h-11 min-w-11 shrink-0 items-center justify-end disabled:opacity-70"
              >
                <span aria-hidden className={`relative h-6 w-11 rounded-full transition-colors ${on ? "bg-accent" : "bg-surface-raised"}`}>
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-foreground transition-[left] ${on ? "left-[22px]" : "left-0.5"}`}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {pushAvailable && (
        <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Push to my phone</span>
            <input
              type="checkbox"
              checked={settings.pushEnabled}
              disabled={saving}
              onChange={(e) => void save({ pushEnabled: e.target.checked })}
              className="h-4 w-4"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Quiet hours</span>
            <input
              type="checkbox"
              checked={quietOn}
              disabled={saving}
              onChange={(e) =>
                void save(
                  e.target.checked
                    ? {
                        quietStart: 22 * 60,
                        quietEnd: 8 * 60,
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                      }
                    : { quietStart: null, quietEnd: null },
                )
              }
              className="h-4 w-4"
            />
          </label>
          {quietOn && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <input
                type="time"
                aria-label="Quiet from"
                value={toTime(settings.quietStart)}
                onChange={(e) => {
                  const v = fromTime(e.target.value);
                  if (v != null) void save({ quietStart: v, quietEnd: settings.quietEnd });
                }}
                className={TIME_INPUT}
              />
              <span>to</span>
              <input
                type="time"
                aria-label="Quiet until"
                value={toTime(settings.quietEnd)}
                onChange={(e) => {
                  const v = fromTime(e.target.value);
                  if (v != null) void save({ quietStart: settings.quietStart, quietEnd: v });
                }}
                className={TIME_INPUT}
              />
            </div>
          )}
          {native &&
            (registered ? (
              releaseButton
            ) : (
              <button
                type="button"
                onClick={() => void handleEnable()}
                disabled={busy}
                className="btn-secondary tap-target w-fit min-h-11 px-4 text-sm disabled:opacity-60"
              >
                {busy ? "Working…" : "Allow notifications on this device"}
              </button>
            ))}
        </div>
      )}
      {!pushAvailable && native && registered && releaseButton}
      {message && (
        <p role="status" className="text-xs text-muted">
          {message}
        </p>
      )}
    </section>
  );
}

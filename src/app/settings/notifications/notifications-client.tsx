"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { ActivityLog } from "@/components/settings/activity-log";
import { DeviceCard } from "@/components/settings/device-card";
import { HealthBanner } from "@/components/settings/health-banner";
import { QuietHoursFields } from "@/components/settings/quiet-hours-fields";
import { SwitchRow } from "@/components/settings/switch";
import type { DeviceOutcome } from "@/lib/notifications/deliver";
import type { DevicePatch } from "@/lib/notifications/registry";
import type { AccountPreferences } from "@/lib/notifications/settings";
import type { NotificationSettingsView } from "@/lib/notifications/view";
import {
  currentSubscriptionEndpoint,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  webPushPermission,
  webPushSupport,
  type WebPushPermission,
  type WebPushSupport,
} from "@/lib/web-push";

/**
 * The notifications settings screen.
 *
 * Every mutation round-trips and the response replaces the whole view. That is
 * a deliberate trade of a little latency for the thing this screen exists to
 * provide: what you see is what the server will actually do. Optimistic local
 * state would let the UI claim a device is receiving notifications while the
 * row that decides says otherwise — the exact failure the screen is meant to
 * surface.
 */
export function NotificationsClient({ initial }: { initial: NotificationSettingsView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, DeviceOutcome | null>>({});

  // Which stored device is the browser sitting in front of, if any.
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null);
  const [permission, setPermission] = useState<WebPushPermission>("unsupported");
  /**
   * Null until the browser has been inspected.
   *
   * Every one of these reads answers differently on the server (no `window`,
   * no `Notification`, no subscription) than in the browser, so committing to
   * an answer during the first render guarantees a hydration mismatch. The
   * card renders a neutral line until this is set, which server and client
   * agree on.
   */
  const [support, setSupport] = useState<WebPushSupport | null>(null);

  // These are reads of the browser, not of React state: permission and the
  // live PushSubscription can change outside this app (site settings, another
  // tab), so they are re-read whenever the view changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const endpoint = await currentSubscriptionEndpoint();
      if (cancelled) return;
      setSupport(webPushSupport());
      setPermission(webPushPermission());
      setThisEndpoint(endpoint);
    })();
    return () => {
      cancelled = true;
    };
  }, [view]);

  const request = useCallback(
    async (key: string, url: string, init: RequestInit): Promise<unknown | null> => {
      setBusy(key);
      setError(null);
      try {
        const res = await fetch(url, init);
        const body = (await res.json().catch(() => null)) as
          | (NotificationSettingsView & { error?: string; details?: string[] })
          | null;
        if (!res.ok) {
          setError(body?.details?.join(", ") ?? body?.error ?? "Something went wrong. Try again.");
          return null;
        }
        return body;
      } catch {
        setError("Could not reach the server. Check your connection and try again.");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const patchAccount = useCallback(
    async (patch: Partial<AccountPreferences>) => {
      const body = await request("account", "/api/notifications/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (body) setView(body as NotificationSettingsView);
    },
    [request],
  );

  const patchDevice = useCallback(
    async (deviceId: string, patch: DevicePatch) => {
      const body = await request(deviceId, `/api/notifications/devices/${deviceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (body) setView(body as NotificationSettingsView);
    },
    [request],
  );

  const removeDevice = useCallback(
    async (deviceId: string) => {
      const body = await request(deviceId, `/api/notifications/devices/${deviceId}`, {
        method: "DELETE",
      });
      if (body) setView(body as NotificationSettingsView);
    },
    [request],
  );

  const testDevice = useCallback(
    async (deviceId: string) => {
      const body = (await request(deviceId, `/api/notifications/devices/${deviceId}/test`, {
        method: "POST",
      })) as { outcome: DeviceOutcome | null; settings: NotificationSettingsView } | null;
      if (!body) return;
      setTestResults((prev) => ({ ...prev, [deviceId]: body.outcome }));
      setView(body.settings);
    },
    [request],
  );

  const refresh = useCallback(async () => {
    const body = await request("refresh", "/api/notifications/settings", { method: "GET" });
    if (body) setView(body as NotificationSettingsView);
  }, [request]);

  const enableHere = useCallback(async () => {
    if (!view.vapidPublicKey) return;
    setBusy("enable");
    setError(null);
    const result = await subscribeToWebPush(view.vapidPublicKey);
    setBusy(null);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setThisEndpoint(result.endpoint);
    await refresh();
  }, [refresh, view.vapidPublicKey]);

  const disableHere = useCallback(async () => {
    setBusy("enable");
    await unsubscribeFromWebPush();
    setBusy(null);
    setThisEndpoint(null);
    await refresh();
  }, [refresh]);

  const jumpToDevice = useCallback((deviceId: string) => {
    document.getElementById(`device-${deviceId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const account = view.account;
  const registeredHere = thisEndpoint
    ? (view.devices.find((d) => d.token === thisEndpoint) ?? null)
    : null;

  return (
    <div className="flex flex-col gap-8">
      <HealthBanner health={view.health} onJumpToDevice={jumpToDevice} />

      {error && (
        <p role="alert" className="rounded-2xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
          {error}
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="this-device-heading">
        <h2 id="this-device-heading" className="section-label mb-3">
          This device
        </h2>
        <div className="card p-5">
          {support === null ? (
            <p className="text-sm leading-relaxed text-muted">Checking this browser&hellip;</p>
          ) : !support.supported ? (
            <p className="text-sm leading-relaxed text-muted">{support.reason}</p>
          ) : registeredHere ? (
            <>
              <p className="text-sm leading-relaxed">
                This browser is set up as{" "}
                <button
                  type="button"
                  onClick={() => jumpToDevice(registeredHere.id)}
                  className="font-medium text-accent underline decoration-dotted underline-offset-4"
                >
                  {registeredHere.name}
                </button>
                . Its settings are below.
              </p>
              <button
                type="button"
                onClick={disableHere}
                disabled={busy === "enable"}
                className="btn-secondary mt-4 px-4 py-2.5 text-sm disabled:opacity-60"
              >
                Turn off in this browser
              </button>
            </>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <BellRing size={20} strokeWidth={1.8} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <div>
                  <p className="font-display text-base font-semibold">
                    Turn on notifications in this browser
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-muted">
                    {permission === "denied"
                      ? "This site is blocked from sending notifications. Allow it in your browser's site settings, then reload this page."
                      : !view.vapidPublicKey
                        ? "This server has no web push key configured, so browser notifications can't be enabled yet."
                        : "You'll be asked for permission once. Nothing is sent until you say yes."}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={enableHere}
                disabled={busy === "enable" || permission === "denied" || !view.vapidPublicKey}
                className="btn-primary mt-4 flex items-center gap-2 px-5 py-3 text-sm disabled:opacity-50"
              >
                {busy === "enable" && <Loader2 size={15} className="animate-spin" aria-hidden />}
                Turn on
              </button>
            </>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="account-heading">
        <h2 id="account-heading" className="section-label mb-3">
          Account defaults
        </h2>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          These apply everywhere unless a device below overrides them.
        </p>

        <div className="card p-5">
          <h3 className="font-display text-base font-semibold">What you get notified about</h3>
          <div className="mt-1 divide-y divide-border-subtle">
            {account.categories.map((category) => (
              <SwitchRow
                key={category.id}
                id={`account-${category.id}`}
                label={category.label}
                description={category.description}
                checked={category.enabled}
                disabled={category.critical}
                badge={category.critical ? <span className="chip">Always on</span> : undefined}
                onChange={(next) => patchAccount({ categories: { [category.id]: next } })}
              />
            ))}
          </div>
        </div>

        <div className="card mt-3 p-5">
          <SwitchRow
            id="account-quiet"
            label="Quiet hours"
            description="Hold notifications overnight. Account & security alerts always come through."
            checked={account.quietHours.enabled}
            onChange={(next) => patchAccount({ quietHoursEnabled: next })}
          />
          {account.quietHours.enabled && (
            <QuietHoursFields
              idPrefix="account"
              start={account.quietHours.start}
              end={account.quietHours.end}
              timeZone={account.quietHours.timeZone}
              onChange={(patch) =>
                patchAccount({
                  quietStart: patch.start ?? account.quietHours.start,
                  quietEnd: patch.end ?? account.quietHours.end,
                  timeZone: patch.timeZone ?? account.quietHours.timeZone,
                })
              }
            />
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="devices-heading">
        <h2 id="devices-heading" className="section-label mb-3">
          Your devices ({view.devices.length})
        </h2>
        {view.devices.length === 0 ? (
          <div className="card flex flex-col items-center gap-3 p-8 text-center">
            <span aria-hidden className="text-4xl">
              🔕
            </span>
            <p className="font-display text-lg font-semibold">No devices yet</p>
            <p className="max-w-xs text-sm leading-relaxed text-muted">
              Turn notifications on above, or open the Whaikey app on your phone — each one shows up
              here with its own settings.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {view.devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                isCurrent={device.token === thisEndpoint}
                accountQuietHours={account.quietHours}
                busy={busy === device.id}
                testResult={testResults[device.id] ?? null}
                onPatch={(patch) => void patchDevice(device.id, patch)}
                onTest={() => void testDevice(device.id)}
                onRemove={() => void removeDevice(device.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="activity-heading">
        <h2 id="activity-heading" className="section-label mb-3">
          Recent activity
        </h2>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          Every attempt from the last little while, including anything your settings held back.
        </p>
        <ActivityLog deliveries={view.deliveries} />
      </section>
    </div>
  );
}

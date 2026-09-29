"use client";

import { useEffect, useState } from "react";
import { isNativeApp } from "@/lib/native/platform";
import { disablePush, pushPermissionState } from "@/lib/native/push";

/**
 * Settings → Notifications.
 *
 * What is true today, and nothing more: Whaikey sends no notifications. The
 * device half exists (`src/lib/native/push.ts`) and nothing is sent through
 * it, so a switch here would be a control with nothing behind it. What this
 * card can honestly do is say that, restate what notifications will never be
 * (PLAN.md §9.8), and — in the app, when this device is registered — let the
 * person take the registration back.
 */
export function NotificationsCard() {
  const [registered, setRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isNativeApp()) return;
    let live = true;
    void pushPermissionState().then((state) => {
      if (live) setRegistered(state === "granted");
    });
    return () => {
      live = false;
    };
  }, []);

  async function handleRelease() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const released = await disablePush().catch(() => false);
    setBusy(false);
    if (released) {
      setRegistered(false);
      setMessage("This device is no longer registered. To stop the app asking again, turn notifications off in your phone's settings.");
    } else {
      setMessage("Couldn't reach the server — this device is still registered. Try again.");
    }
  }

  return (
    <section aria-labelledby="notifications-heading" className="card flex flex-col gap-3 p-5">
      <div>
        <p className="section-label">Notifications</p>
        <h2 id="notifications-heading" className="mt-1 font-display text-xl font-semibold">
          None, for now
        </h2>
      </div>
      <p className="text-sm leading-relaxed text-muted">
        Whaikey doesn&rsquo;t send notifications yet. When it does they will be things you ask for —
        a wishlist price, a friend&rsquo;s invite — switched on here, one at a time. Never a nudge to
        pour.
      </p>
      {registered && (
        <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
          <p className="text-sm">This device is registered for notifications.</p>
          <button
            type="button"
            onClick={() => void handleRelease()}
            disabled={busy}
            className="btn-secondary tap-target w-fit min-h-11 px-4 text-sm disabled:opacity-60"
          >
            {busy ? "Working…" : "Unregister this device"}
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="text-xs text-muted">
          {message}
        </p>
      )}
    </section>
  );
}

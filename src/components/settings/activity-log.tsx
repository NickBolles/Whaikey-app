"use client";

import type { DeliveryView } from "@/lib/notifications/view";

/**
 * The last twenty send attempts, suppressions included.
 *
 * This is the difference between "notifications are broken" and a diagnosis.
 * A held-for-quiet-hours row and a failed-delivery row look nothing alike here,
 * which is the whole point: without the log both present to the user as an
 * empty lock screen, and they need opposite fixes.
 */
export function ActivityLog({ deliveries }: { deliveries: DeliveryView[] }) {
  if (deliveries.length === 0) {
    return (
      <p className="card-flat rounded-2xl p-5 text-sm text-muted">
        Nothing has been sent yet. Once notifications start going out, every attempt shows up
        here — including the ones held back by your settings.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {deliveries.map((delivery) => (
        <li key={delivery.id} className="card-flat rounded-2xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{delivery.title}</p>
              <p className="mt-0.5 text-xs text-muted">
                {delivery.categoryLabel}
                {delivery.deviceLabel ? ` · ${delivery.deviceLabel}` : ""}
              </p>
              {delivery.detail && (
                <p className="mt-1 text-xs leading-relaxed text-muted/80">{delivery.detail}</p>
              )}
            </div>
            <div className="shrink-0 text-right">
              <span
                className={`chip ${
                  delivery.tone === "ok"
                    ? "border-success/40 text-success"
                    : delivery.tone === "error"
                      ? "border-danger/40 text-danger"
                      : "border-accent/50 text-accent"
                }`}
              >
                {delivery.statusLabel}
              </span>
              <p className="mt-1.5 text-[11px] text-muted">
                {/* Machine-readable instant on the element, server-formatted
                    text inside it — see DeliveryView.createdAtLabel. */}
                <time dateTime={delivery.createdAt}>{delivery.createdAtLabel}</time>
              </p>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

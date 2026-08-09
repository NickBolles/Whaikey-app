"use client";

import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { AccountHealth, HealthSeverity } from "@/lib/notifications/health";

/**
 * The answer, before the settings.
 *
 * "Are my notifications working" is the question people arrive with, and a
 * screen that opens with thirty toggles makes them derive it. This banner
 * states it in one line and lists the specific devices behind a bad answer,
 * each with the one action that fixes it.
 */
const TONE: Record<HealthSeverity, { border: string; text: string; Icon: typeof Info }> = {
  ok: { border: "border-success/40 bg-success/10", text: "text-success", Icon: CheckCircle2 },
  info: { border: "border-border bg-surface-raised", text: "text-muted", Icon: Info },
  warn: { border: "border-accent/40 bg-accent/10", text: "text-accent", Icon: AlertTriangle },
  error: { border: "border-danger/40 bg-danger/10", text: "text-danger", Icon: XCircle },
};

export function HealthBanner({
  health,
  onJumpToDevice,
}: {
  health: AccountHealth;
  /** Scrolls the offending device card into view. */
  onJumpToDevice?: (deviceId: string) => void;
}) {
  const tone = TONE[health.severity];
  const { Icon } = tone;

  return (
    <section
      aria-label="Notification status"
      // Assertive would interrupt a screen reader mid-toggle; this updates after
      // every save, so it announces politely.
      aria-live="polite"
      className={`rounded-2xl border p-4 ${tone.border}`}
    >
      <div className="flex items-start gap-3">
        <Icon size={20} strokeWidth={1.8} className={`mt-0.5 shrink-0 ${tone.text}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-semibold">{health.headline}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">{health.detail}</p>

          {health.issues.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2.5">
              {health.issues.map((issue, index) => (
                <li key={`${issue.deviceId ?? "account"}-${index}`} className="text-sm">
                  <p className="font-medium">
                    {issue.deviceId && onJumpToDevice ? (
                      <button
                        type="button"
                        onClick={() => onJumpToDevice(issue.deviceId as string)}
                        className="text-left underline decoration-dotted underline-offset-4 hover:text-accent"
                      >
                        {issue.label}
                      </button>
                    ) : (
                      issue.label
                    )}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{issue.detail}</p>
                  {issue.fix && (
                    <p className="mt-0.5 text-xs leading-relaxed text-accent/90">{issue.fix}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** The small status pill on each device card. */
export function HealthChip({ severity, children }: { severity: HealthSeverity; children: React.ReactNode }) {
  const tone =
    severity === "ok"
      ? "border-success/40 text-success"
      : severity === "error"
        ? "border-danger/40 text-danger"
        : severity === "warn"
          ? "border-accent/50 text-accent"
          : "border-border text-muted";
  return <span className={`chip shrink-0 ${tone}`}>{children}</span>;
}

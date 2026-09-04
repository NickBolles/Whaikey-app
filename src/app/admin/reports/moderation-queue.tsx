"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ModerationActionKind, ReportSubjectType } from "@/db/schema";

/**
 * The operator's screen (PLAN.md §9.4).
 *
 * Deliberately plain. It is an internal tool for one person and it needs to be
 * fast to read and hard to mis-tap, not designed — the only visual work here
 * is making a breached SLA impossible to skim past.
 *
 * Every action carries a note. It is required for a suspension and offered for
 * everything else, because the audit trail is what an appeal gets answered
 * from and "hidden by an operator, no reason recorded" answers nothing.
 */
interface QueuedReportView {
  id: string;
  subjectType: ReportSubjectType;
  subjectId: string;
  reason: string;
  createdAt: string;
  reporterHandle: string | null;
  ageHours: number;
  preview: string | null;
  subjectOwnerId: string | null;
  subjectOwnerSuspended: boolean;
  alreadyHidden: boolean;
}

interface AuditView {
  id: string;
  action: ModerationActionKind;
  subjectType: ReportSubjectType;
  subjectId: string;
  note: string | null;
  createdAt: string;
  actorName: string;
}

export function ModerationQueue({
  reports,
  breached,
  slaHours,
  audit,
}: {
  reports: QueuedReportView[];
  breached: number;
  slaHours: number;
  audit: AuditView[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/admin/moderation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-4 py-8 max-w-3xl mx-auto w-full flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-muted">
          {reports.length === 0
            ? "Nothing open."
            : `${reports.length} open · target is ${slaHours} hours`}
          {breached > 0 && (
            <strong className="text-danger">
              {" "}
              · {breached} past {slaHours}h
            </strong>
          )}
        </p>
        <Link href="/admin/submissions" className="text-sm text-accent hover:underline w-fit">
          Submitted bottles →
        </Link>
      </header>

      {error && (
        <p role="alert" className="card p-3 text-sm text-danger">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {reports.map((report) => (
          <ReportRow
            key={report.id}
            report={report}
            slaHours={slaHours}
            busy={busy === report.id}
            onAct={(body) => void act(report.id, body)}
          />
        ))}
      </ul>

      <section className="flex flex-col gap-2">
        <h2 className="section-label">Recent actions</h2>
        {audit.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {audit.map((entry) => (
              <li key={entry.id} className="card-flat p-3 text-xs text-muted">
                <span className="text-foreground font-medium">{entry.action}</span>{" "}
                {entry.subjectType} <code>{entry.subjectId.slice(0, 8)}</code> · {entry.actorName} ·{" "}
                {new Date(entry.createdAt).toLocaleString()}
                {entry.note && <div className="mt-1 italic">{entry.note}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ReportRow({
  report,
  slaHours,
  busy,
  onAct,
}: {
  report: QueuedReportView;
  slaHours: number;
  busy: boolean;
  onAct: (body: Record<string, unknown>) => void;
}) {
  const [note, setNote] = useState("");
  const late = report.ageHours >= slaHours;

  return (
    <li className={`card p-4 flex flex-col gap-3 ${late ? "border-danger/60" : ""}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">
          {report.subjectType} · {report.reason}
        </span>
        <span className={`text-xs ${late ? "text-danger font-semibold" : "text-muted"}`}>
          {report.ageHours}h old
        </span>
      </div>

      <p className="text-sm text-muted leading-relaxed whitespace-pre-wrap">
        {report.preview ?? "(the reported thing no longer exists)"}
      </p>

      <p className="text-xs text-muted">
        reported by {report.reporterHandle ? `@${report.reporterHandle}` : "a deleted account"}
        {report.alreadyHidden && report.subjectType !== "profile" && " · already hidden"}
        {report.subjectOwnerSuspended && " · author suspended"}
      </p>

      <label className="sr-only" htmlFor={`note-${report.id}`}>
        Reason for this decision
      </label>
      <input
        id={`note-${report.id}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why — recorded in the audit trail"
        className="w-full rounded-xl border border-border-subtle bg-surface py-2.5 px-3 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/70"
      />

      <div className="flex flex-wrap gap-2">
        {/* No Hide for a profile: its only lever is a switch in the account's
            own settings, so hiding one would last until its owner found the
            toggle they already have — while telling the operator they had
            acted. A profile is suspended or it is not. */}
        {report.subjectType !== "profile" && (
          <button
            type="button"
            disabled={busy || report.alreadyHidden}
            onClick={() =>
              onAct({
                action: "hide",
                subjectType: report.subjectType,
                subjectId: report.subjectId,
                reportId: report.id,
                note,
              })
            }
            className="btn-secondary px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Hide
          </button>
        )}
        {report.subjectOwnerId && !report.subjectOwnerSuspended && (
          <button
            type="button"
            disabled={busy || note.trim().length === 0}
            title={note.trim() ? undefined : "A suspension needs a reason the account can appeal"}
            onClick={() =>
              onAct({
                action: "suspend",
                userId: report.subjectOwnerId,
                reason: note,
                reportId: report.id,
              })
            }
            className="btn-secondary px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Suspend author
          </button>
        )}
        {report.subjectOwnerId && report.subjectOwnerSuspended && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct({ action: "reinstate", userId: report.subjectOwnerId, note })}
            className="btn-secondary px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Reinstate author
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct({ action: "dismiss", reportId: report.id, note })}
          className="px-4 py-2 text-sm text-muted hover:text-foreground transition-colors disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}

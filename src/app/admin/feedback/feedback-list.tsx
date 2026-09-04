"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The feedback queue's rows (PLAN.md §9.7).
 *
 * Outstanding first, then what has been dealt with — a list where everything
 * looks the same is a list where the thing waiting on you is invisible.
 */
export interface FeedbackView {
  id: string;
  body: string;
  contact: string | null;
  platform: string | null;
  appVersion: string | null;
  createdAt: string;
  handled: boolean;
  senderName: string | null;
  senderEmail: string | null;
}

export function FeedbackList({ rows }: { rows: FeedbackView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function markHandled(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/admin/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && (
        <p role="alert" className="card p-3 text-sm text-danger">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`card p-4 flex flex-col gap-2 ${row.handled ? "opacity-60" : ""}`}
          >
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{row.body}</p>
            <p className="text-xs text-muted">
              {row.senderName ? `${row.senderName} (${row.senderEmail})` : "signed out"}
              {row.contact && ` · replies to ${row.contact}`}
              {row.platform && ` · ${row.platform}`}
              {row.appVersion && ` ${row.appVersion}`}
              {` · ${new Date(row.createdAt).toLocaleString()}`}
              {row.handled && " · handled"}
            </p>
            {!row.handled && (
              <button
                type="button"
                disabled={busy === row.id}
                onClick={() => void markHandled(row.id)}
                className="btn-secondary inline-flex min-h-11 self-start items-center px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                Mark handled
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

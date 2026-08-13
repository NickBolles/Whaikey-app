"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Trash2 } from "lucide-react";

export interface SharedLinkRow {
  code: string;
  pourId: string;
  bottleId: string;
  bottleName: string;
  /** ISO timestamp — serialized crossing the server→client boundary. */
  createdAt: string;
}

/** US-2: every active share link, with instant revoke (optimistic removal). */
export function SharedLinksList({ shares }: { shares: SharedLinkRow[] }) {
  const [rows, setRows] = useState(shares);
  const [busyPourId, setBusyPourId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRevoke(pourId: string) {
    if (busyPourId) return;
    setBusyPourId(pourId);
    setError(null);
    const previous = rows;
    setRows((current) => current.filter((row) => row.pourId !== pourId));
    try {
      const res = await fetch(`/api/pours/${pourId}/share`, { method: "DELETE" });
      if (!res.ok) throw new Error("Couldn’t revoke that link.");
    } catch (err) {
      setRows(previous);
      setError(err instanceof Error ? err.message : "Couldn’t revoke that link.");
    } finally {
      setBusyPourId(null);
    }
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted">All your shared links are revoked.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.code} className="card-flat flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <Link
                href={`/bottles/${row.bottleId}`}
                className="block truncate font-medium hover:text-accent transition-colors"
              >
                {row.bottleName}
              </Link>
              <p className="mt-0.5 text-xs text-muted">
                Shared{" "}
                {new Date(row.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href={`/s/${row.code}`}
                target="_blank"
                rel="noopener noreferrer"
                className="tap-target inline-flex items-center gap-1.5 rounded-xl border border-border-subtle px-3 py-2 text-xs text-muted transition-colors hover:border-accent/60 hover:text-foreground"
              >
                <ExternalLink size={16} strokeWidth={1.8} aria-hidden /> View
              </Link>
              <button
                type="button"
                onClick={() => handleRevoke(row.pourId)}
                disabled={busyPourId === row.pourId}
                className="tap-target inline-flex items-center gap-1.5 rounded-xl border border-border-subtle px-3 py-2 text-xs text-muted transition-colors hover:border-danger/60 hover:text-danger disabled:opacity-60"
              >
                <Trash2 size={16} strokeWidth={1.8} aria-hidden />
                {busyPourId === row.pourId ? "Revoking…" : "Revoke"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

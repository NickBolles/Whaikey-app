"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { WhiskeyCategory } from "@/db/schema";

/**
 * The operator's catalog screen (PLAN.md §9.4).
 *
 * Plain for the same reason `/admin/reports` is: an internal tool for one
 * person, where the only thing worth styling is what must not be mis-tapped.
 *
 * Approving is the irreversible-ish one — it makes a row visible to everyone
 * and publishes its barcode as catalog truth — so it is the action that shows
 * the whole submission first, and a submission the reviewer made themselves is
 * marked as such rather than blocked: with one operator, blocking it would
 * mean their own bottles never enter the catalog.
 */
interface SubmissionView {
  id: string;
  bottleId: string;
  name: string;
  category: WhiskeyCategory | null;
  distilleryName: string | null;
  distilleryText: string | null;
  country: string | null;
  region: string | null;
  abv: number | null;
  upc: string | null;
  source: string | null;
  createdAt: string;
  ageHours: number;
  submitterHandle: string | null;
  isOwn: boolean;
}

export function SubmissionQueue({
  submissions,
  pending,
}: {
  submissions: SubmissionView[];
  pending: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/admin/submissions", {
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
        <h1 className="font-display text-2xl font-semibold">Submitted bottles</h1>
        <p className="text-sm text-muted">
          {pending === 0 ? "Nothing waiting." : `${pending} waiting on review`}
          {pending > submissions.length && ` · showing the ${submissions.length} oldest`}
        </p>
        <nav className="flex gap-3 text-sm">
          <Link href="/admin/reports" className="text-accent hover:underline">
            Reports →
          </Link>
          <Link href="/admin/feedback" className="text-accent hover:underline">
            Feedback →
          </Link>
        </nav>
      </header>

      {error && (
        <p role="alert" className="card p-3 text-sm text-danger">
          {error}
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {submissions.map((submission) => (
          <SubmissionRow
            key={submission.id}
            submission={submission}
            busy={busy === submission.id}
            onAct={(body) => void act(submission.id, body)}
          />
        ))}
      </ul>
    </div>
  );
}

function SubmissionRow({
  submission,
  busy,
  onAct,
}: {
  submission: SubmissionView;
  busy: boolean;
  onAct: (body: Record<string, unknown>) => void;
}) {
  const [note, setNote] = useState("");
  const [duplicateOf, setDuplicateOf] = useState("");

  const facts = [
    submission.category,
    submission.distilleryName ?? (submission.distilleryText && `${submission.distilleryText} (unmatched)`),
    [submission.region, submission.country].filter(Boolean).join(", ") || null,
    submission.abv != null ? `${submission.abv}% ABV` : null,
    submission.upc ? `UPC ${submission.upc}` : null,
  ].filter(Boolean);

  return (
    <li className="card p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        {/* `/bottles/[id]` is 404 for anyone but the submitter while the
            bottle is pending — `catalogVisibleTo` says so and the operator is
            not an exception to it. The queue carries the facts a review needs
            inline instead of linking somewhere that would just fail. */}
        <span className="font-medium">{submission.name}</span>
        <span className="text-xs text-muted">{submission.ageHours}h old</span>
      </div>

      <p className="text-sm text-muted leading-relaxed">{facts.join(" · ")}</p>

      <p className="text-xs text-muted">
        from {submission.submitterHandle ? `@${submission.submitterHandle}` : "an account with no handle"}
        {submission.source && ` · via ${submission.source}`}
        {submission.isOwn && " · your own submission"}
      </p>

      <label className="sr-only" htmlFor={`note-${submission.id}`}>
        Reason for this decision
      </label>
      <input
        id={`note-${submission.id}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why — kept on the submission"
        className="w-full rounded-xl border border-border-subtle bg-surface py-2.5 px-3 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/70"
      />

      {/*
        Real height and 12px of separation, for the reason spelled out beside
        the moderation queue's row and in `globals.css`: `tap-target` grows the
        hit area without growing the control, so on adjacent buttons the areas
        overlap and the later one in DOM order wins the tap. Consequential here
        because "Add to catalog" publishes the bottle AND its barcode as
        catalog truth for everybody, one tap from Decline.
      */}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct({ action: "approve", submissionId: submission.id, note })}
          className="btn-primary inline-flex min-h-11 items-center px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Add to catalog
        </button>
        <button
          type="button"
          disabled={busy || note.trim().length === 0}
          title={note.trim() ? undefined : "A decline needs a reason the submitter can read"}
          onClick={() => onAct({ action: "reject", submissionId: submission.id, reason: note })}
          className="btn-secondary inline-flex min-h-11 items-center px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Decline
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`dupe-${submission.id}`}>
          Id of the bottle this duplicates
        </label>
        <input
          id={`dupe-${submission.id}`}
          value={duplicateOf}
          onChange={(e) => setDuplicateOf(e.target.value)}
          placeholder="Duplicate of bottle id"
          className="flex-1 min-w-[14rem] rounded-xl border border-border-subtle bg-surface py-2 px-3 text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/70"
        />
        <button
          type="button"
          disabled={busy || duplicateOf.trim().length === 0}
          onClick={() =>
            onAct({
              action: "duplicate",
              submissionId: submission.id,
              duplicateOfBottleId: duplicateOf.trim(),
              note,
            })
          }
          className="inline-flex min-h-11 items-center px-4 py-2 text-sm text-muted hover:text-foreground transition-colors disabled:opacity-50"
        >
          Mark duplicate
        </button>
      </div>
    </li>
  );
}

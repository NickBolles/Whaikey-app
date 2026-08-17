"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { MessageCircle, Share2 } from "lucide-react";
import {
  agreementRows,
  matchPercent,
  type BottleComparison,
  type CompareProseNote,
  type CompareSource,
} from "@/lib/compare-math";
import { leafLabel } from "@/lib/flavor-wheel";
import { share } from "@/lib/native/share";
import { FlavorChip } from "@/components/flavor-chip";
import { UserAvatar } from "@/components/user-avatar";

/** Bars scale against a full-intensity (3) descriptor. */
const MAX_INTENSITY = 3;
const YOU_COLOR = "#e8a13c";
const THEM_COLOR = "#6b7f8a";

const SOURCE_META: Record<CompareSource, { name: string; short: string; empty: string }> = {
  friends: {
    name: "Friends",
    short: "friends",
    empty: "None of your friends have logged this bottle yet — the seat's open.",
  },
  community: {
    name: "Community",
    short: "the community",
    empty: "No public community pours of this bottle yet.",
  },
  professional: {
    name: "Professional",
    short: "the pros",
    empty: "No producer or critic notes on file for this bottle.",
  },
};

function barWidth(intensity: number): string {
  return `${Math.min(100, (intensity / MAX_INTENSITY) * 100)}%`;
}

/**
 * The three-reference comparison screen. Switching segments is pure client
 * state — everything arrived with the page, so no re-fetch and no scroll
 * reset — and each segment computes its own match percentage.
 */
export function CompareClient({ comparison }: { comparison: BottleComparison }) {
  const [source, setSource] = useState<CompareSource>("friends");
  // Local so a tapped "+" chip re-computes the match inline.
  const [viewerTags, setViewerTags] = useState(comparison.viewerTags);
  const [shareStatus, setShareStatus] = useState<string | null>(null);

  const sourceTags =
    source === "friends"
      ? comparison.friends.tags
      : source === "community"
        ? comparison.community.tags
        : comparison.professional.tags;
  const hasSourceData = Object.keys(sourceTags).length > 0;
  const rows = useMemo(() => agreementRows(viewerTags, sourceTags), [viewerTags, sourceTags]);
  const match = useMemo(() => matchPercent(viewerTags, sourceTags), [viewerTags, sourceTags]);

  const producer = comparison.professional.producer;
  const producerTagIds = Object.keys(producer?.tags ?? {});
  const sharedWithProducer = producerTagIds.filter((id) => (viewerTags[id] ?? 0) > 0);

  async function addTag(leafId: string) {
    if (!comparison.viewerPourId) return;
    const before = viewerTags;
    setViewerTags((cur) => ({ ...cur, [leafId]: Math.max(cur[leafId] ?? 0, 1) }));
    const res = await fetch(`/api/bottles/${comparison.bottleId}/note-tags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leafId }),
    }).catch(() => null);
    if (!res?.ok) setViewerTags(before);
  }

  async function shareComparison() {
    if (!comparison.viewerPourId) return;
    setShareStatus(null);
    try {
      const res = await fetch(`/api/pours/${comparison.viewerPourId}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => null)) as { path?: string } | null;
      if (!res.ok || !body?.path) throw new Error();
      const url = new URL(body.path, window.location.origin).toString();
      const outcome = await share({
        title: `My ${comparison.bottleName} note`,
        text: "How my tasting note reads — from Whaikey.",
        url,
        dialogTitle: "Share comparison",
      });
      setShareStatus(outcome === "copied" ? "Link copied" : "Link ready");
    } catch {
      setShareStatus("Couldn't create a share link.");
    }
  }

  const discussPourId = comparison.friends.notes[0]?.pourId ?? null;
  const segmentNotes: CompareProseNote[] =
    source === "friends"
      ? comparison.friends.notes
      : source === "community"
        ? comparison.community.notes
        : [];

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-5">
      <div>
        <Link
          href={`/bottles/${comparison.bottleId}`}
          className="tap-target font-mono text-[11px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-foreground"
        >
          ← {comparison.bottleName}
        </Link>
        <h1 className="mt-2 font-display text-[27px] font-semibold leading-tight">
          Your note, compared
        </h1>
        <p className="mt-1 text-sm text-muted">
          Three references, one dram. None of them is an answer key.
        </p>
      </div>

      {/* Agreement panel: three DISTINCT sources, never one blended number. */}
      <section aria-label="Agreement" className="card flex flex-col gap-4 p-4">
        <div
          role="tablist"
          aria-label="Comparison source"
          className="flex gap-1.5"
        >
          {(
            [
              { key: "friends", label: `Friends · ${comparison.friends.count}` },
              { key: "community", label: `Community · ${comparison.community.count}` },
              { key: "professional", label: "Professional" },
            ] as Array<{ key: CompareSource; label: string }>
          ).map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={source === tab.key}
              onClick={() => setSource(tab.key)}
              className={`tap-target inline-flex min-h-9 flex-1 items-center justify-center rounded-full border px-2 text-[12.5px] font-medium transition-colors ${
                source === tab.key
                  ? "chip-active"
                  : "border-border-subtle text-muted hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {hasSourceData ? (
          <>
            <ul className="flex flex-col gap-2.5" aria-label="Agreement bars">
              {rows.map((row) => (
                <li key={row.leafId} className="flex items-center gap-3">
                  <span className="w-[104px] shrink-0 truncate text-xs text-foreground/85">
                    {leafLabel(row.leafId) ?? row.leafId}
                  </span>
                  <span
                    className="relative h-5 min-w-0 flex-1 overflow-hidden rounded-[6px]"
                    style={{ backgroundColor: "#221a12" }}
                    aria-label={`${leafLabel(row.leafId)}: you ${row.mine}, them ${row.theirs}`}
                  >
                    <span
                      className="absolute left-0 top-0 h-1/2"
                      style={{ width: barWidth(row.mine), backgroundColor: YOU_COLOR }}
                    />
                    <span
                      className="absolute bottom-0 left-0 h-1/2"
                      style={{ width: barWidth(row.theirs), backgroundColor: THEM_COLOR }}
                    />
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted">
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: YOU_COLOR }} />
                  You
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: THEM_COLOR }} />
                  {SOURCE_META[source].name}
                </span>
              </span>
              <span className="font-mono tabular-nums" data-testid="match-percent">
                {match != null
                  ? `${match}% match with ${SOURCE_META[source].short}`
                  : "nothing to match yet"}
              </span>
            </div>
          </>
        ) : (
          // The absence is informative, so the segment stays and says so.
          <p className="px-1 text-sm text-muted">{SOURCE_META[source].empty}</p>
        )}
      </section>

      {/* The distillery card is the fixed reference: visible under EVERY segment. */}
      {producer && (
        <section aria-label="Distillery note" className="card flex flex-col gap-3 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="chip px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]">
              Distillery
            </span>
            <span className="font-mono text-[11px] text-muted tabular-nums">
              {sharedWithProducer.length} of {producerTagIds.length} shared
            </span>
          </div>
          {producer.text && (
            <p className="font-display text-[15px] italic leading-relaxed text-foreground/80">
              {producer.text}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {producerTagIds.map((leafId) =>
              (viewerTags[leafId] ?? 0) > 0 ? (
                <FlavorChip key={leafId} leafId={leafId} variant="confirmed" />
              ) : (
                <FlavorChip
                  key={leafId}
                  leafId={leafId}
                  variant="suggested"
                  onClick={comparison.viewerPourId ? () => addTag(leafId) : undefined}
                  aria-label={`Add ${leafLabel(leafId) ?? leafId} to your note`}
                />
              ),
            )}
          </div>
          <a
            href={producer.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-muted transition-colors hover:text-foreground"
          >
            {producer.sourceLabel}
          </a>
        </section>
      )}

      {/* Prose notes for the active segment. */}
      {source === "professional" ? (
        comparison.professional.critics.length > 0 ? (
          <ul className="flex flex-col gap-2.5" aria-label="Critic notes">
            {comparison.professional.critics.map((critic, i) => (
              <li key={`${critic.publication}-${i}`} className="card-flat flex flex-col gap-2 p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2">
                    <span className="chip px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]">
                      Critic
                    </span>
                    <span className="text-sm font-medium">{critic.publication}</span>
                  </span>
                  {critic.score && (
                    <span className="shrink-0 font-mono text-[13px] font-semibold text-accent tabular-nums">
                      {critic.score}
                      {critic.scoreScale && (
                        <span className="text-muted">{critic.scoreScale}</span>
                      )}
                    </span>
                  )}
                </div>
                <p className="text-sm leading-relaxed text-foreground/85">{critic.note}</p>
              </li>
            ))}
          </ul>
        ) : null
      ) : segmentNotes.length > 0 ? (
        <ul className="flex flex-col gap-2.5" aria-label={source === "friends" ? "Friend notes" : "Community notes"}>
          {segmentNotes.map((note) => (
            <li key={note.pourId} className="card-flat flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2.5">
                  <UserAvatar name={note.author.displayName || note.author.handle} image={note.author.avatarUrl} size={26} />
                  <Link
                    href={`/u/${note.author.handle}`}
                    className="truncate text-sm font-medium transition-colors hover:text-accent"
                  >
                    @{note.author.handle}
                  </Link>
                </span>
                {note.rating != null && (
                  <span className="shrink-0 font-mono text-[13px] font-semibold text-accent tabular-nums">
                    {note.rating.toFixed(1)}
                  </span>
                )}
              </div>
              {note.text && <p className="text-sm leading-relaxed text-foreground/85">{note.text}</p>}
            </li>
          ))}
        </ul>
      ) : null}

      {/* Footer actions. */}
      {(comparison.viewerPourId || discussPourId) && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2.5">
            {comparison.viewerPourId && (
              <button
                type="button"
                onClick={shareComparison}
                className="btn-primary flex min-h-11 flex-1 items-center justify-center gap-2 px-4 py-3 text-sm"
              >
                <Share2 size={18} strokeWidth={1.8} aria-hidden />
                Share comparison
              </button>
            )}
            {discussPourId && (
              <Link
                href={`/notes/${discussPourId}`}
                className="btn-secondary flex min-h-11 flex-1 items-center justify-center gap-2 px-4 py-3 text-sm font-medium"
              >
                <MessageCircle size={18} strokeWidth={1.8} aria-hidden />
                Discuss
              </Link>
            )}
          </div>
          {shareStatus && (
            <p role="status" className="text-xs text-muted">
              {shareStatus}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Circle, Loader2, Minus } from "lucide-react";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import type { EnrichmentView } from "@/lib/enrich/queue";

/**
 * "Building this bottle's card" — the live panel on a just-added bottle's page
 * (src/lib/enrich/queue.ts). It polls the bottle's enrichment feed — each
 * poll also moves the job to its next step — and fills the card in as each
 * step reports. When the job
 * finishes it refreshes the server-rendered page so the radar and the meta
 * line pick up what was found. Everything degrades to text: a paused or
 * over-budget queue reads "Queued — we'll finish this soon", a failure points
 * at the daily catalog pass.
 */

type View = EnrichmentView;
type RowState = "pending" | "active" | "found" | "none";

export interface PanelRow {
  key: "profile" | "notes" | "details";
  label: string;
  state: RowState;
  detail: string | null;
}

const POLL_ACTIVE_MS = 2000;
const POLL_WAITING_MS = 10_000;

function lastMessage(view: View, predicate: (e: View["events"][number]) => boolean): string | null {
  for (let i = view.events.length - 1; i >= 0; i--) if (predicate(view.events[i])) return view.events[i].message;
  return null;
}

/** The checklist, derived from the event log (pure, unit-tested). */
export function deriveRows(view: View): PanelRow[] {
  const ev = view.events;
  const job = view.job;
  const stepActive = (step: string) =>
    job?.state === "running" &&
    ev.some((e) => e.kind === "step_started" && e.step === step) &&
    !ev.some((e) => e.kind === "step_done" && e.step === step);
  const webDone = job?.stepsDone.includes("web") ?? false;
  const finished = job?.state === "done" || job?.state === "failed";
  const found = (field: string) => ev.some((e) => e.kind === "found" && e.data?.field === field);

  const profileFound = found("profile") || (view.fields.profile != null && (job?.stepsDone.length ?? 0) > 0);
  const profile: PanelRow = {
    key: "profile",
    label: "Flavor profile",
    state: profileFound ? "found" : stepActive("keyword") || stepActive("quick") || stepActive("web") ? "active" : finished ? "none" : "pending",
    detail: profileFound ? lastMessage(view, (e) => e.kind === "found" && e.data?.field === "profile")?.replace(/^[^—]*— /, "") ?? null : null,
  };
  if (profile.detail) profile.detail = profile.detail[0].toUpperCase() + profile.detail.slice(1);

  const notesFound = found("notes") || view.fields.notes != null;
  const sourcesN = view.fields.sources?.length ?? 0;
  const notes: PanelRow = {
    key: "notes",
    label: "Tasting notes",
    state: notesFound ? "found" : stepActive("web") ? "active" : webDone || finished ? "none" : "pending",
    detail: notesFound
      ? `From ${sourcesN} published source${sourcesN === 1 ? "" : "s"}`
      : webDone
        ? lastMessage(view, (e) => e.kind === "step_done" && e.step === "web")
        : null,
  };

  const detailsFound = found("details");
  const details: PanelRow = {
    key: "details",
    label: "Details",
    state: detailsFound ? "found" : stepActive("web") ? "active" : webDone || finished ? "none" : "pending",
    detail: detailsFound
      ? lastMessage(view, (e) => e.kind === "found" && e.data?.field === "details")?.replace(/^Found details — /, "") ?? null
      : webDone || finished
        ? "Nothing new to add"
        : null,
  };
  return [profile, notes, details];
}

/** One status line under the heading. */
export function statusLine(view: View): string {
  const job = view.job;
  if (!job) return "";
  if (job.state === "done") return "Card complete";
  if (job.state === "failed") return "Couldn't finish this one — the daily catalog pass will pick it up.";
  if (job.state === "queued" && job.waiting === "error") return "Hit a snag — retrying shortly";
  if (job.state === "queued" && job.waiting) return "Queued — we'll finish this soon. You can leave; the card fills in on its own.";
  const last = view.events[view.events.length - 1];
  if (job.state === "queued") return "Queued — checking sources shortly";
  if (last?.kind === "step_started") return `${last.message}…`;
  return "Checking sources…";
}

function mergeView(prev: View, next: View): View {
  const seen = new Set(prev.events.map((e) => e.seq));
  return { ...next, events: [...prev.events, ...next.events.filter((e) => !seen.has(e.seq))] };
}

function RowIcon({ state }: { state: RowState }) {
  if (state === "found") return <Check size={14} strokeWidth={2.4} aria-hidden className="text-accent" />;
  if (state === "active") return <Loader2 size={14} strokeWidth={2} aria-hidden className="animate-spin text-muted motion-reduce:animate-none" />;
  if (state === "none") return <Minus size={14} strokeWidth={2} aria-hidden className="text-muted/60" />;
  return <Circle size={12} strokeWidth={1.6} aria-hidden className="text-muted/50" />;
}

function ProfileBars({ profile }: { profile: Record<string, number> }) {
  return (
    <div className="grid grid-cols-4 gap-x-3 gap-y-1.5" aria-label="Flavor profile so far">
      {FLAVOR_WHEEL.map((w) => {
        const v = Math.max(0, Math.min(10, profile[w.id] ?? 0));
        return (
          <div key={w.id} className="min-w-0">
            <div className="flex items-baseline justify-between text-[10px] leading-none text-muted">
              <span className="truncate">{w.label}</span>
              <span className="tabular-nums">{v}</span>
            </div>
            <div className="mt-1 h-1 rounded-full bg-foreground/10 overflow-hidden">
              <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${v * 10}%`, background: w.color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SourcedNotes({ notes, sources }: { notes: NonNullable<View["fields"]["notes"]>; sources: View["fields"]["sources"] }) {
  const rows = (["nose", "palate", "finish"] as const).filter((k) => notes[k]);
  return (
    <div className="flex flex-col gap-1.5">
      <dl className="grid grid-cols-[3.5rem_1fr] gap-x-2 gap-y-1 text-[13px] leading-snug">
        {rows.map((k) => (
          <div key={k} className="contents">
            <dt className="text-[11px] uppercase tracking-[0.12em] text-muted pt-px">{k}</dt>
            <dd className="text-foreground/85">{notes[k]}</dd>
          </div>
        ))}
      </dl>
      {sources && sources.length > 0 && (
        <p className="text-[11px] text-muted leading-relaxed">
          AI summary of published notes ·{" "}
          {sources.map((s, i) => (
            <span key={s.url}>
              {i > 0 && ", "}
              <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-muted/40 hover:text-accent">
                {s.label}
              </a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

export function LiveEnrichment({ bottleId, initial }: { bottleId: string; initial: View }) {
  const [view, setView] = useState<View>(initial);
  const router = useRouter();
  const seqRef = useRef(initial.events.reduce((m, e) => Math.max(m, e.seq), 0));
  const started = view.job?.createdAt ? Date.parse(view.job.createdAt) : null;
  const [now, setNow] = useState<number | null>(null);
  const open = view.job != null && view.job.state !== "done" && view.job.state !== "failed";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await fetch(`/api/bottles/${bottleId}/enrichment?after=${seqRef.current}`, { cache: "no-store" });
        if (res.ok && !cancelled) {
          const next = (await res.json()) as View;
          for (const e of next.events) seqRef.current = Math.max(seqRef.current, e.seq);
          setView((prev) => mergeView(prev, next));
          if (next.job && (next.job.state === "done" || next.job.state === "failed")) {
            // The radar, meta line and notes are server-rendered; pull them in.
            router.refresh();
            return;
          }
          const waiting = next.job?.state === "queued" && next.job.waiting != null;
          timer = setTimeout(tick, waiting ? POLL_WAITING_MS : POLL_ACTIVE_MS);
          return;
        }
      } catch {
        // Offline or a blip: keep the last state and try again more slowly.
      }
      if (!cancelled) timer = setTimeout(tick, POLL_WAITING_MS);
    };
    timer = setTimeout(tick, 600);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [bottleId, open, router]);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    // First reading on the next tick too, so server and client render alike.
    return () => clearInterval(id);
  }, [open]);

  if (!view.job) return null;
  const rows = deriveRows(view);
  const status = statusLine(view);
  const elapsed = now != null && started != null ? Math.max(0, Math.round((now - started) / 1000)) : 0;
  const done = view.job.state === "done";
  const chip = done ? "Done" : view.job.state === "failed" ? "Later" : view.job.waiting ? "Queued" : "Live";

  return (
    <section aria-label="Building this bottle's card" className="card p-3 flex flex-col gap-2.5" data-testid="live-enrichment">
      <div className="flex items-center justify-between gap-2">
        <h2 className="section-label">{done ? "Card built" : "Building this bottle's card"}</h2>
        <span className={`chip px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${chip === "Live" || chip === "Done" ? "chip-active" : ""}`}>
          {chip === "Live" && <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle animate-pulse motion-reduce:animate-none" />}
          {chip}
        </span>
      </div>
      <p className="text-[13px] text-foreground/80 leading-snug" role="status" aria-live="polite">
        {status}
        {open && elapsed > 0 && <span className="ml-1.5 text-[11px] text-muted tabular-nums">{elapsed}s</span>}
      </p>
      <ul className="flex flex-col divide-y divide-border/60 border-y border-border/60">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2 py-1.5 text-[13px]" data-state={r.state}>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center"><RowIcon state={r.state} /></span>
            <span className={r.state === "found" ? "font-medium" : "text-foreground/75"}>{r.label}</span>
            <span className="ml-auto min-w-0 truncate text-right text-[12px] text-muted">{r.detail ?? (r.state === "active" ? "looking…" : "")}</span>
          </li>
        ))}
      </ul>
      {view.fields.profile && <ProfileBars profile={view.fields.profile} />}
      {view.fields.notes && <SourcedNotes notes={view.fields.notes} sources={view.fields.sources} />}
    </section>
  );
}

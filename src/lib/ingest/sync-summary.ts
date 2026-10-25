import type { IngestReport } from "./types";

/**
 * Per-source outcome of a catalog-sync run, and the roll-up the weekly
 * workflow publishes (step summary, `catalog-sync-summary` artifact, and the
 * body of the alert issue).
 *
 * Why this exists: the sync was red for seven straight weeks and nobody
 * noticed, and the one source that was silently broken (Oregon, 0 candidates
 * from 7,493 rows) was *green* the whole time. A run's health is a property of
 * its numbers, not just of its exit codes, so each source writes one of these
 * and the report step decides — from the counts — what the run was.
 *
 *  - `ok`        the source produced candidates (or was allowed not to).
 *  - `degraded`  the third party is down or no longer serves data
 *                (SourceUnavailableError). Not fixable by a rerun or by our
 *                code, so the run stays green-with-warning and an issue opens.
 *  - `empty`     rows came back but nothing survived parsing/filtering — the
 *                Oregon failure mode. Treated as a failure: it is almost
 *                always a format change we have to adapt to.
 *  - `failed`    the step threw (network, DB, a bug).
 *  - `skipped`   deliberately not run (e.g. an optional API key is unset).
 */
export const SOURCE_RUN_STATUSES = ["ok", "degraded", "empty", "failed", "skipped"] as const;
export type SourceRunStatus = (typeof SOURCE_RUN_STATUSES)[number];

export interface SourceRunSummary {
  source: string;
  status: SourceRunStatus;
  scanned?: number;
  candidates?: number;
  matchedExisting?: number;
  inserted?: number;
  upcsAdded?: number;
  catalogBefore?: number;
  catalogAfter?: number;
  durationMs?: number;
  /** Error text, degradation reason or skip reason. Never contains secrets. */
  message?: string;
  dryRun?: boolean;
}

/** The status an ingest report earns on its own numbers. */
export function classifyReport(report: IngestReport, opts: { allowEmpty?: boolean } = {}): SourceRunStatus {
  if (report.candidates === 0 && !opts.allowEmpty) return "empty";
  return "ok";
}

export function summaryFromReport(
  report: IngestReport,
  extra: { catalogBefore: number; catalogAfter: number; durationMs: number; allowEmpty?: boolean },
): SourceRunSummary {
  const status = classifyReport(report, { allowEmpty: extra.allowEmpty });
  return {
    source: report.source,
    status,
    scanned: report.scanned,
    candidates: report.candidates,
    matchedExisting: report.matchedExisting,
    inserted: report.inserted,
    upcsAdded: report.upcsAdded,
    catalogBefore: extra.catalogBefore,
    catalogAfter: extra.catalogAfter,
    durationMs: extra.durationMs,
    dryRun: report.dryRun,
    message:
      status === "empty"
        ? `scanned ${report.scanned} rows but produced 0 candidates — the source format probably changed`
        : undefined,
  };
}

export type OverallStatus = "ok" | "degraded" | "failed";

export interface SummaryRow extends SourceRunSummary {
  /** Candidates last run, when the previous run's artifact was available. */
  previousCandidates?: number;
  /** candidates − previousCandidates. */
  candidateDelta?: number;
}

export interface CatalogSyncSummary {
  overall: OverallStatus;
  generatedAt: string;
  catalogBefore: number | null;
  catalogAfter: number | null;
  totals: { scanned: number; candidates: number; inserted: number; upcsAdded: number };
  rows: SummaryRow[];
  /** Human-readable reasons the run is not `ok`, one per line. */
  problems: string[];
  /** Notable but non-failing observations (e.g. a large candidate drop). */
  warnings: string[];
}

/**
 * A source whose candidates fall by more than this share run-over-run gets a
 * warning. Not a failure: Iowa and Oregon legitimately shrink when a state
 * delists a batch, but a halving is worth a human look before it becomes the
 * next silent zero.
 */
export const CANDIDATE_DROP_WARNING = 0.5;

export function aggregateSyncSummaries(
  current: SourceRunSummary[],
  previous: SourceRunSummary[] = [],
  opts: { expected?: string[]; now?: Date } = {},
): CatalogSyncSummary {
  const prevBySource = new Map(previous.map((p) => [p.source, p]));
  const seen = new Set(current.map((c) => c.source));
  const rows: SummaryRow[] = current.map((c) => {
    const prev = prevBySource.get(c.source);
    const row: SummaryRow = { ...c };
    if (prev?.candidates != null && c.candidates != null) {
      row.previousCandidates = prev.candidates;
      row.candidateDelta = c.candidates - prev.candidates;
    }
    return row;
  });
  // A source that was supposed to run but left no summary crashed before it
  // could write one (or its step never started) — that is a failure, and the
  // old workflow's blind spot.
  for (const source of opts.expected ?? []) {
    if (!seen.has(source)) {
      rows.push({ source, status: "failed", message: "no summary written — the step did not run to completion" });
    }
  }

  const problems: string[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    if (row.status === "failed" || row.status === "empty" || row.status === "degraded") {
      problems.push(`${row.source}: ${row.status}${row.message ? ` — ${row.message}` : ""}`);
    }
    if (
      row.status === "ok" &&
      row.previousCandidates != null &&
      row.previousCandidates > 0 &&
      row.candidates != null &&
      row.candidates < row.previousCandidates * (1 - CANDIDATE_DROP_WARNING)
    ) {
      warnings.push(`${row.source}: candidates fell ${row.previousCandidates} → ${row.candidates} since the last run`);
    }
  }

  const overall: OverallStatus = rows.some((r) => r.status === "failed" || r.status === "empty")
    ? "failed"
    : rows.some((r) => r.status === "degraded")
      ? "degraded"
      : "ok";

  const withCatalog = rows.filter((r) => r.catalogBefore != null && r.catalogAfter != null);
  const sum = (key: "scanned" | "candidates" | "inserted" | "upcsAdded") =>
    rows.reduce((n, r) => n + (r[key] ?? 0), 0);

  return {
    overall,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    catalogBefore: withCatalog.length ? Math.min(...withCatalog.map((r) => r.catalogBefore!)) : null,
    catalogAfter: withCatalog.length ? Math.max(...withCatalog.map((r) => r.catalogAfter!)) : null,
    totals: { scanned: sum("scanned"), candidates: sum("candidates"), inserted: sum("inserted"), upcsAdded: sum("upcsAdded") },
    rows,
    problems,
    warnings,
  };
}

const ICON: Record<SourceRunStatus, string> = {
  ok: "✅",
  degraded: "⚠️",
  empty: "❌",
  failed: "❌",
  skipped: "⏭️",
};

const fmt = (n: number | undefined) => (n == null ? "–" : n.toLocaleString("en-US"));
const fmtDelta = (n: number | undefined) => (n == null ? "–" : n > 0 ? `+${fmt(n)}` : n === 0 ? "0" : fmt(n));

export function renderSyncSummaryMarkdown(summary: CatalogSyncSummary, opts: { runUrl?: string } = {}): string {
  const head = { ok: "✅ Catalog sync healthy", degraded: "⚠️ Catalog sync degraded", failed: "❌ Catalog sync failed" }[
    summary.overall
  ];
  const lines = [`## ${head}`, ""];
  if (summary.catalogBefore != null && summary.catalogAfter != null) {
    lines.push(
      `Catalog: **${fmt(summary.catalogBefore)} → ${fmt(summary.catalogAfter)}** bottles ` +
        `(${fmtDelta(summary.catalogAfter - summary.catalogBefore)}); ` +
        `${fmt(summary.totals.upcsAdded)} new barcodes.`,
      "",
    );
  }
  lines.push(
    "| Source | Status | Rows | Candidates | Δ vs last run | Matched | New bottles | New barcodes | Note |",
    "|---|---|--:|--:|--:|--:|--:|--:|---|",
  );
  for (const r of summary.rows) {
    const note = (r.message ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 160);
    lines.push(
      `| ${r.source} | ${ICON[r.status]} ${r.status} | ${fmt(r.scanned)} | ${fmt(r.candidates)} | ${fmtDelta(r.candidateDelta)} | ` +
        `${fmt(r.matchedExisting)} | ${fmt(r.inserted)} | ${fmt(r.upcsAdded)} | ${note} |`,
    );
  }
  if (summary.problems.length) lines.push("", "**Problems**", ...summary.problems.map((p) => `- ${p}`));
  if (summary.warnings.length) lines.push("", "**Warnings**", ...summary.warnings.map((w) => `- ${w}`));
  if (opts.runUrl) lines.push("", `Run: ${opts.runUrl}`);
  return `${lines.join("\n")}\n`;
}

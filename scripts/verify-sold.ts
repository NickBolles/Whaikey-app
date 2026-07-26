#!/usr/bin/env tsx
/**
 * Bulk catalog verification queue controller (durable work/run/attempt
 * foundation — src/lib/ingest/verification-queue.ts; worker execution phase
 * — src/lib/ingest/verification-worker.ts; docs/DATA_SOURCES.md).
 *
 * `--apply` snapshots imported bottles into durable work rows, then runs a
 * bounded in-process pool of workers that claim leased batches, verify them
 * against the authenticated Claude Code CLI *subscription* (never an API
 * key — see src/lib/ingest/claude-code-client.ts), and finalize every
 * claimed row exactly once. There is no API fallback: if the CLI isn't
 * logged in, or the preflight smoke probe fails, the run aborts before any
 * lease is claimed, and any already-leased rows simply self-heal back to
 * "queued" once their lease expires (see reclaimExpiredLeases).
 *
 * This is unrelated to `enrich-claude-code.ts --verify-sold`, which still
 * does synchronous, immediate LLM-based verification against
 * src/lib/ingest/verify-sold.ts — that path is untouched by this change.
 *
 * Usage:
 *   pnpm verify-sold --dry-run --limit 50 --model sonnet
 *   pnpm verify-sold --apply   --limit 50 --model sonnet [--workers 2] [--batch-size 5]
 *   pnpm verify-sold --report <run-id>
 *   pnpm verify-sold --resume <run-id> --apply --limit 50 --model sonnet
 *
 * `--dry-run` only previews what would be enqueued — it never touches
 * `catalog_verification_work` and never calls Claude (no subscription usage).
 *
 * Preflight: one `migrateDb` call against DATABASE_URL runs before any queue
 * operation (same one-migration preflight every other script here uses).
 * Workers never migrate — they only ever receive an already-migrated `db`.
 *
 * Worker safety cap: --workers is hard-capped at MAX_WORKERS (4); operate
 * with 2-4. This controller processes up to `--limit` rows per invocation,
 * scheduling them in `--batch-size` chunks; it never polls the provider.
 * Run a new bounded invocation to process the next queue slice.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { closeDb, createDb, resolveDbUrl } from "../src/db";
import { migrateDb } from "../src/db/migrate";
import { runClaudeStructured } from "../src/lib/ingest/claude-code-client";
import {
  createVerificationRun,
  DEFAULT_LEASE_MS,
  getVerificationRun,
  MAX_WORKERS,
  previewSnapshot,
  resolveModel,
  snapshotRun,
  summarizeRun,
  summarizeRunWorkStatuses,
  type WorkStatusSummary,
} from "../src/lib/ingest/verification-queue";
import { runSmokeProbe, runVerificationWorkers, summarizeWorkerOutcomes } from "../src/lib/ingest/verification-worker";

const DEFAULT_WORKERS = 2;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_PARTITIONS = 1;

const ARTIFACTS_DIR = path.join(process.cwd(), "artifacts", "verification-runs");

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = value(name);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function requiredPositiveInteger(name: string): number {
  if (value(name) == null) throw new Error(`--${name} is required`);
  return positiveInteger(name, 0);
}

function requiredValue(name: string): string {
  const raw = value(name);
  if (!raw) throw new Error(`--${name} is required`);
  return raw;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  scripts/verify-sold.ts (--dry-run | --apply) --limit N --model <alias> [--workers N] [--batch-size N] [--partitions N]",
      "  scripts/verify-sold.ts --report <run-id>",
      "  scripts/verify-sold.ts --resume <run-id> (--dry-run | --apply) --limit N --model <alias> [--workers N] [--batch-size N] [--partitions N]",
    ].join("\n"),
  );
  process.exit(1);
}

function writeArtifact(runId: string, payload: unknown): string {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const file = path.join(ARTIFACTS_DIR, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

/** Fails fast with a clear message rather than letting the CLI fall back to any other auth path. */
function requireClaudeCodeLogin(): void {
  const result = spawnSync("claude", ["auth", "status", "--text"], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error("Claude Code is not authenticated. Run `claude auth login` first — this controller never falls back to an API key.");
  }
}

/** The seven-field checkpoint report shape shared by --apply, --report, and --resume. */
function buildCheckpointReport(scanned: number, workStatus: WorkStatusSummary) {
  return {
    runId: workStatus.runId,
    scanned,
    leased: workStatus.touched,
    verified: workStatus.verified,
    not_evidenced: workStatus.notEvidenced,
    retryable: workStatus.retryable,
    rejected: workStatus.rejected,
    errors: workStatus.errors,
  };
}

async function main(): Promise<void> {
  const reportId = value("report");
  const resumeId = value("resume");
  const dryRun = hasFlag("dry-run");
  const apply = hasFlag("apply");

  if (reportId && (dryRun || apply || resumeId)) usage();
  if (!reportId && dryRun === apply) usage(); // exactly one of --dry-run/--apply, outside --report mode

  const url = resolveDbUrl();
  const db = createDb(url);
  try {
    await migrateDb(db, url);

    if (reportId) {
      const run = await getVerificationRun(db, reportId);
      if (!run) throw new Error(`No verification run found for id ${reportId}`);
      const scanned = (run.summary as { snapshot?: { scanned?: number } } | null)?.snapshot?.scanned ?? 0;
      const workStatus = await summarizeRunWorkStatuses(db, reportId);
      const report = buildCheckpointReport(scanned, workStatus);
      const file = writeArtifact(reportId, { run, report, workStatus });
      console.log(`[verify-sold] run ${reportId} (${run.mode}, ${run.status}): ${JSON.stringify(report)}`);
      console.log(`Report written to ${file}`);
      return;
    }

    const limit = requiredPositiveInteger("limit");
    const requestedModel = requiredValue("model");
    const workers = positiveInteger("workers", DEFAULT_WORKERS);
    const batchSize = positiveInteger("batch-size", DEFAULT_BATCH_SIZE);
    const partitions = positiveInteger("partitions", DEFAULT_PARTITIONS);
    if (workers > MAX_WORKERS) {
      throw new Error(`--workers (${workers}) exceeds the safety cap of ${MAX_WORKERS}. Use 2-4 workers.`);
    }

    let run = resumeId ? await getVerificationRun(db, resumeId) : null;
    if (resumeId) {
      if (!run) throw new Error(`No verification run found for id ${resumeId}`);
      const resolved = resolveModel(requestedModel);
      if (resolved !== run.resolvedModel) {
        throw new Error(
          `--model ${requestedModel} resolves to ${resolved}, but run ${resumeId} is pinned to ${run.resolvedModel}. Start a new run to change models.`,
        );
      }
    } else {
      run = await createVerificationRun(db, {
        mode: dryRun ? "dry_run" : "apply",
        requestedModel,
        workers,
        batchSize,
        limit,
        partitions,
        config: { argv: process.argv.slice(2) },
      });
    }

    console.log(
      `[verify-sold] run ${run!.id} (${run!.mode}) model=${run!.resolvedModel} workers=${workers} batchSize=${batchSize} limit=${limit}`,
    );

    if (dryRun) {
      // No lease is claimed, no row is written, and — critically — no Claude call is ever made on this path.
      const { result, candidates } = await previewSnapshot(db, limit);
      const file = writeArtifact(run!.id, {
        run: run!,
        preview: result,
        candidates: candidates.map(({ id, priority, reasonCodes, alreadyQueued }) => ({ id, priority, reasonCodes, alreadyQueued })),
      });
      console.log(
        `[verify-sold] (dry run, no writes, no Claude calls) ${result.scanned} imported bottles scanned → ${result.enqueued} would be newly queued, ${result.skippedExisting} already in the durable queue.`,
      );
      console.log(`Report written to ${file}`);
      return;
    }

    requireClaudeCodeLogin();

    const snapshot = await snapshotRun(db, run!.id);
    console.log(
      `[verify-sold] snapshot: ${snapshot.scanned} scanned → ${snapshot.enqueued} newly queued, ${snapshot.skippedExisting} already queued.`,
    );

    const smokeProbe = await runSmokeProbe(runClaudeStructured, run!.resolvedModel);
    console.log(`[verify-sold] preflight smoke probe (model=${smokeProbe.model}): ${smokeProbe.ok ? "ok" : "FAILED"} ${JSON.stringify(smokeProbe.output ?? smokeProbe.error)}`);
    if (!smokeProbe.ok) {
      const file = writeArtifact(run!.id, { run: run!, snapshot, smokeProbe });
      console.log(`Report written to ${file}`);
      throw new Error("Preflight smoke probe failed — aborting before claiming any work. See the artifact for details.");
    }

    // `--limit` is the total bounded work budget. Workers consume it in
    // `--batch-size` chunks; multiplying by worker count here would make a
    // user-requested 100-row run silently process only (workers × batchSize).
    const leaseCap = limit;
    const workerRun = await runVerificationWorkers(db, {
      runId: run!.id,
      workers,
      batchSize,
      leaseCap,
      model: run!.resolvedModel,
      claudeRunner: runClaudeStructured,
      leaseMs: DEFAULT_LEASE_MS,
    });
    const invocationReport = summarizeWorkerOutcomes(workerRun.outcomes);
    console.log(
      `[verify-sold] this invocation: leased ${workerRun.leased} row(s) → ` +
        `${invocationReport.verified} verified, ${invocationReport.notEvidenced} not_evidenced, ` +
        `${invocationReport.retryable} retryable, ${invocationReport.rejected} rejected, ${invocationReport.errors} errors.`,
    );

    const durableSummary = await summarizeRun(db, run!.id);
    const workStatus = await summarizeRunWorkStatuses(db, run!.id);
    const report = buildCheckpointReport(snapshot.scanned, workStatus);
    console.log(`[verify-sold] run totals: ${JSON.stringify(report)}`);

    const file = writeArtifact(run!.id, {
      run: await getVerificationRun(db, run!.id),
      snapshot,
      smokeProbe,
      invocation: { ...invocationReport, outcomes: workerRun.outcomes },
      report,
      workStatus,
      durableSummary,
    });
    console.log(`Report written to ${file}`);
  } finally {
    await closeDb(db);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });

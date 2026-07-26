#!/usr/bin/env tsx
/**
 * Bulk catalog verification queue controller (durable work/run/attempt
 * foundation — src/lib/ingest/verification-queue.ts, docs/DATA_SOURCES.md).
 *
 * Phase 1 scope: this controller may only create a run, snapshot imported
 * bottles into durable work rows, lease (claim) bounded batches, and report.
 * It NEVER calls Claude — the worker execution loop that would actually
 * verify a leased batch is a future PR, and there is no API fallback path:
 * if that loop isn't wired up, leased rows simply sit until their lease
 * expires and self-heals back to "queued" (see reclaimExpiredLeases).
 *
 * This is unrelated to `enrich-claude-code.ts --verify-sold`, which still
 * does synchronous, immediate LLM-based verification against
 * src/lib/ingest/verify-sold.ts — that path is untouched by this PR.
 *
 * Usage:
 *   pnpm verify-sold --dry-run --limit 50 --model sonnet
 *   pnpm verify-sold --apply   --limit 50 --model sonnet [--workers 2] [--batch-size 5] [--partitions 1]
 *   pnpm verify-sold --report <run-id>
 *   pnpm verify-sold --resume <run-id> --apply --limit 50 --model sonnet
 *
 * Preflight: one `migrateDb` call against DATABASE_URL runs before any queue
 * operation (same one-migration preflight every other script here uses).
 *
 * Worker safety cap: --workers is hard-capped at MAX_WORKERS (4); operate
 * with 2-4. This controller does not itself poll a provider repeatedly — it
 * performs exactly one bounded claim per partition per invocation.
 */
import fs from "node:fs";
import path from "node:path";
import { closeDb, createDb, resolveDbUrl } from "../src/db";
import { migrateDb } from "../src/db/migrate";
import {
  claimWork,
  createVerificationRun,
  DEFAULT_LEASE_MS,
  getVerificationRun,
  MAX_WORKERS,
  previewSnapshot,
  resolveModel,
  snapshotRun,
  summarizeRun,
} from "../src/lib/ingest/verification-queue";

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
      const summary = await summarizeRun(db, reportId);
      const file = writeArtifact(reportId, { run: await getVerificationRun(db, reportId), summary });
      console.log(`[verify-sold] run ${reportId} (${run.mode}, ${run.status}): ${JSON.stringify(summary)}`);
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
      `[verify-sold] run ${run!.id} (${run!.mode}) model=${run!.resolvedModel} workers=${workers} batchSize=${batchSize} partitions=${partitions} limit=${limit}`,
    );

    if (dryRun) {
      const { result, candidates } = await previewSnapshot(db, limit);
      const file = writeArtifact(run!.id, {
        run: run!,
        preview: result,
        candidates: candidates.map(({ id, priority, reasonCodes, alreadyQueued }) => ({ id, priority, reasonCodes, alreadyQueued })),
      });
      console.log(
        `[verify-sold] (dry run, no writes) ${result.scanned} imported bottles scanned → ${result.enqueued} would be newly queued, ${result.skippedExisting} already in the durable queue.`,
      );
      console.log(`Report written to ${file}`);
      return;
    }

    const snapshot = await snapshotRun(db, run!.id);
    console.log(
      `[verify-sold] snapshot: ${snapshot.scanned} scanned → ${snapshot.enqueued} newly queued, ${snapshot.skippedExisting} already queued.`,
    );

    const leaseResults: Array<{ partition: number; leased: number }> = [];
    let totalLeased = 0;
    const leaseCap = workers * batchSize;
    for (let partition = 0; partition < partitions && totalLeased < leaseCap; partition++) {
      const claimed = await claimWork(db, {
        runId: run!.id,
        worker: `controller-p${partition}`,
        partition,
        batchSize: Math.min(batchSize, leaseCap - totalLeased),
        leaseMs: DEFAULT_LEASE_MS,
      });
      leaseResults.push({ partition, leased: claimed.length });
      totalLeased += claimed.length;
    }
    console.log(
      `[verify-sold] leased ${totalLeased} row(s) across ${leaseResults.length} partition(s). ` +
        "No worker execution loop is wired up yet — leased rows sit until a future worker finalizes them, " +
        `or self-heal back to "queued" after their ${Math.round(DEFAULT_LEASE_MS / 60_000)}-minute lease expires.`,
    );

    const summary = await summarizeRun(db, run!.id);
    const file = writeArtifact(run!.id, { run: await getVerificationRun(db, run!.id), snapshot, leaseResults, summary });
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

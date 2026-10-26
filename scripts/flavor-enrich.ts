#!/usr/bin/env tsx
/**
 * Tiered flavor-profile backfill CLI (docs/DATA_SOURCES.md §2.4,
 * src/lib/ingest/flavor-tiers.ts). Runs against DATABASE_URL.
 *
 *   pnpm flavor free    (--apply | --dry-run) [--summary FILE]
 *   pnpm flavor export  --out FILE [--cheap-limit N] [--heavy-top N] [--upgrade-keyword]
 *   pnpm flavor apply   --in FILE (--apply | --dry-run) [--summary FILE]
 *   pnpm flavor coverage [--summary FILE]
 *
 * Deliberately never calls migrateDb: the provenance table is created with
 * idempotent DDL so this can run from a branch without applying (and
 * mis-ordering) unmerged drizzle migrations against production.
 *
 * The model passes run on the operator host that holds the Codex
 * subscription login (scripts/flavor-codex-bridge.py): `export` writes prompt
 * batches, the host fills in raw model text, `apply` validates and writes.
 */
import { readFile, writeFile } from "node:fs/promises";
import { closeDb, createDb, resolveDbUrl } from "../src/db";
import {
  applyModelResults,
  exportModelCandidates,
  flavorCoverage,
  runFreePass,
  withDbRetry,
  type ModelResultBatch,
} from "../src/lib/ingest/flavor-tiers";

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const int = (name: string, fallback: number) => {
  const raw = value(name);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
};

function mode(): { dryRun: boolean } {
  if (flag("apply") === flag("dry-run")) throw new Error("pass exactly one of --apply or --dry-run");
  return { dryRun: flag("dry-run") };
}

async function writeSummary(summary: unknown): Promise<void> {
  console.log(JSON.stringify(summary, null, 2));
  const path = value("summary");
  if (path) await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

/**
 * Before/after coverage is a report, not the job: a slow or timed-out
 * coverage read must never fail (or mask) a pass that already wrote its rows.
 */
async function coverageOrNull(db: Parameters<typeof flavorCoverage>[0]): Promise<Awaited<ReturnType<typeof flavorCoverage>> | { error: string }> {
  try {
    return await withDbRetry(() => flavorCoverage(db), { attempts: 2 });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const db = createDb(resolveDbUrl());
  const started = Date.now();
  try {
    if (command === "free") {
      const { dryRun } = mode();
      const before = await coverageOrNull(db);
      const report = await runFreePass(db, { dryRun });
      const after = await coverageOrNull(db);
      await writeSummary({ command, report, before, after, seconds: Math.round((Date.now() - started) / 1000) });
    } else if (command === "export") {
      const out = value("out");
      if (!out) throw new Error("--out FILE is required");
      const result = await exportModelCandidates(db, {
        cheapLimit: int("cheap-limit", 5000),
        heavyTop: int("heavy-top", 2500),
        upgradeKeyword: flag("upgrade-keyword"),
      });
      await writeFile(out, JSON.stringify(result), "utf8");
      await writeSummary({ command, counts: result.counts, batches: result.batches.length, coverage: await coverageOrNull(db) });
    } else if (command === "apply") {
      const input = value("in");
      if (!input) throw new Error("--in FILE is required");
      const { dryRun } = mode();
      const parsed = JSON.parse(await readFile(input, "utf8")) as { batches?: ModelResultBatch[] };
      if (!Array.isArray(parsed.batches)) throw new Error("results file has no batches array");
      const before = await coverageOrNull(db);
      const report = await applyModelResults(db, parsed.batches, { dryRun });
      const after = await coverageOrNull(db);
      await writeSummary({ command, report, before, after, seconds: Math.round((Date.now() - started) / 1000) });
    } else if (command === "coverage") {
      await writeSummary({ command, coverage: await flavorCoverage(db) });
    } else {
      throw new Error("usage: pnpm flavor (free|export|apply|coverage) …");
    }
  } finally {
    await closeDb(db);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * Roll the per-source summaries of a catalog-sync run into one report.
 *
 *   tsx scripts/catalog-sync-report.ts --dir <summaries> --out <dir>
 *       [--previous <summary.json>] [--expected iowa,oregon,…] [--run-url URL]
 *
 * Reads every `*.json` SourceRunSummary in --dir (written by
 * `pnpm ingest <source> --summary FILE`), compares candidate counts with the
 * previous run's `summary.json` when given, and writes:
 *
 *   <out>/summary.json   CatalogSyncSummary (also the next run's --previous)
 *   <out>/summary.md     the table, appended to $GITHUB_STEP_SUMMARY
 *
 * and sets the `status` step output (ok | degraded | failed). It never exits
 * non-zero for a bad run — the workflow decides what a status means (open an
 * issue, fail the job) — only for bad arguments. No database access.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  aggregateSyncSummaries,
  renderSyncSummaryMarkdown,
  SOURCE_RUN_STATUSES,
  type CatalogSyncSummary,
  type SourceRunSummary,
} from "../src/lib/ingest/sync-summary";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isSummary(value: unknown): value is SourceRunSummary {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.source === "string" && (SOURCE_RUN_STATUSES as readonly string[]).includes(String(v.status));
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const dir = arg("dir");
  const out = arg("out");
  if (!dir || !out) {
    console.error("Usage: tsx scripts/catalog-sync-report.ts --dir DIR --out DIR [--previous FILE] [--expected a,b] [--run-url URL]");
    process.exit(2);
  }

  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
  const current: SourceRunSummary[] = [];
  for (const file of files) {
    const value = await readJson(join(dir, file));
    if (isSummary(value)) current.push(value);
    else console.warn(`ignoring ${file}: not a source summary`);
  }

  const previousPath = arg("previous");
  const previous = previousPath ? ((await readJson(previousPath)) as CatalogSyncSummary | null) : null;
  const expected = (arg("expected") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const summary = aggregateSyncSummaries(current, previous?.rows?.filter(isSummary) ?? [], { expected });
  const markdown = renderSyncSummaryMarkdown(summary, { runUrl: arg("run-url") });

  await mkdir(out, { recursive: true });
  await writeFile(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(join(out, "summary.md"), markdown, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${summary.overall}\n`, "utf8");

  console.log(markdown);
  for (const problem of summary.problems) {
    const level = summary.overall === "failed" ? "error" : "warning";
    if (process.env.GITHUB_ACTIONS) console.log(`::${level}::${problem}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

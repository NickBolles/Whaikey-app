/**
 * Catalog ingestion CLI (docs/DATA_SOURCES.md §2, §6). Runs against
 * DATABASE_URL, same bootstrapping as db:seed.
 *
 *   pnpm ingest iowa [--dry-run]
 *   pnpm ingest cola --since 2026-01-01 [--until 2026-07-01] [--dry-run]
 *   pnpm ingest cola --full [--until 2026-07-01] [--dry-run]
 *   pnpm ingest oregon|utah|bc|systembolaget|whiskyedition|vinmonopolet [--dry-run]
 *   pnpm ingest resources --manifest ./path/to/manifest.json [--apply]
 *   pnpm ingest enrich [--limit N] [--batch-size N] [--no-web] [--dry-run]
 *   pnpm ingest prune            # delete imported bottles untouched by users
 *
 * Catalog sources (iowa, cola, oregon, …) also accept:
 *   --summary FILE   write a SourceRunSummary JSON (src/lib/ingest/sync-summary.ts)
 *                    that the weekly workflow rolls up into its report
 *   --allow-empty    a 0-candidate result is OK (short COLA windows); without
 *                    it, 0 candidates exits 1 — that is how the Oregon header
 *                    rename stayed invisible for seven weeks
 * A source that is unavailable (HTML/parking page instead of data —
 * SourceUnavailableError) exits 0 with status "degraded" and a warning.
 *
 * Sources:
 *   iowa   — Iowa Liquor Products open dataset (CC-BY 4.0): names, categories,
 *            ABV, 750ml state retail price, UPCs. Full-catalog sync, ~4k
 *            whiskey SKUs; safe to re-run monthly (the feed updates monthly).
 *   cola   — TTB public COLA registry: newly label-approved whiskies (name +
 *            category only). Date-ranged; run e.g. weekly with a short window.
 *   oregon — Oregon OLCC monthly pricing (state open data): names, categories,
 *            age, ABV, 750ml shelf price. ~1.3k whiskey SKUs; monthly.
 *   utah   — Utah DABS product list (fiscal-period XLSX discovered from the
 *            product-list page): names, categories, 750ml price. Monthly.
 *   bc     — BC Liquor price list (Open Government Licence — BC, via the BC
 *            Data Catalogue): names, categories, ABV, and real product
 *            barcodes. Prices are CAD and not imported. Monthly.
 *   systembolaget — Swedish monopoly assortment via the community data mirror
 *            (susbolaget.emrik.org): European/Scotch names, categories, ABV.
 *            Prices are SEK and not imported. Enrichment source only.
 *   whiskyedition — WHISKY:EDITION review API (CC BY 4.0, attribution
 *            required): ~500 reviewed bottlings with region, age, ABV.
 *   vinmonopolet — official Norwegian monopoly products API (free key from
 *            api.vinmonopolet.no via VINMONOPOLET_API_KEY). The sanctioned
 *            API returns names only; value is European name coverage and
 *            sold-at-retail evidence, with conservative name-cue categories.
 *   enrich — fills flavor-wheel profiles for bottles without one
 *            (imported/user-submitted); discovery recommends them once verified. Bottles
 *            with enough user tasting notes are rolled up directly (no AI);
 *            the rest go to the model with description + user-note context
 *            and web search to discover published tasting notes (requires
 *            OPENROUTER_API_KEY or ANTHROPIC_API_KEY). OpenRouter uses its
 *            Anthropic-compatible Messages API but does not accept Anthropic
 *            hosted web search, so --no-web is implied there.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createDb, resolveDbUrl, type DB } from "../src/db";
import { migrateDb } from "../src/db/migrate";
import { refreshCatalogTotals } from "../src/lib/catalog-totals";
import {
  countBottles,
  COLA_FULL_HISTORY_START,
  enrichBottleProfiles,
  enrichModel,
  fetchBcCandidates,
  fetchColaRecords,
  colaRecordsToCandidates,
  fetchIowaCandidates,
  fetchOregonCandidates,
  fetchSystembolagetCandidates,
  fetchUtahCandidates,
  fetchVinmonopoletCandidates,
  fetchWhiskyEditionCandidates,
  ingestCandidates,
  ingestSourceManifest,
  pruneImportedBottles,
  type CatalogSourceManifest,
} from "../src/lib/ingest";
import { AiNotConfiguredError } from "../src/lib/ai/client";
import { SourceUnavailableError, type IngestReport } from "../src/lib/ingest/types";
import { summaryFromReport, type SourceRunSummary } from "../src/lib/ingest/sync-summary";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Held so the run's end can refresh the passport denominators (below). */
let ingestDb: DB | undefined;

async function main(): Promise<void> {
  const source = process.argv[2];
  const dryRun = hasFlag("dry-run");
  const url = resolveDbUrl();
  const db = createDb(url);
  ingestDb = db;
  await migrateDb(db, url);

  if (source === "resources") {
    const manifestPath = arg("manifest");
    if (!manifestPath) {
      console.error("resources requires --manifest <path-to-json>");
      process.exit(1);
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CatalogSourceManifest;
    const report = await ingestSourceManifest(db, manifest, { apply: hasFlag("apply") });
    const summary =
      `[resources]${report.apply ? "" : " (dry run)"} ${report.resources} resources: ` +
      `${report.fetched} fetched, ${report.claimsExtracted} claims extracted, ${report.mediaExtracted} media discovered; ` +
      `${report.resourcesWritten} resources, ${report.claimsWritten} claims, ${report.mediaWritten} media written, ` +
      `${report.bottlesPromoted} bottles promoted, ${report.errors.length} errors.`;
    console.log(summary);
    const reportPath = arg("report");
    if (reportPath) {
      await writeFile(reportPath, `${JSON.stringify({ summary, ...report }, null, 2)}\n`, "utf8");
    }
    for (const error of report.errors) console.error(`  ${error.url}: ${error.error}`);
    if (report.errors.length > 0) process.exitCode = 1;
    return;
  }

  if (source === "enrich") {
    const limit = arg("limit") ? Number(arg("limit")) : undefined;
    const batchSize = arg("batch-size") ? Number(arg("batch-size")) : undefined;
    const web = !hasFlag("no-web");
    try {
      console.log(`Enriching flavor profiles with ${enrichModel()}${web ? " + web search" : ""}…`);
      const report = await enrichBottleProfiles(db, {
        limit,
        batchSize,
        web,
        dryRun,
        onBatch: (batch, enriched) => console.log(`  batch ${batch}: ${enriched} enriched so far`),
      });
      console.log(
        `[enrich]${report.dryRun ? " (dry run)" : ""} ${report.candidates} bottles without profiles → ` +
          `${report.fromNotes} from user notes, ${report.fromAi} from the model, ` +
          `${report.rejected} rejected across ${report.batches} batches.`,
      );
      // Enrichment has no "empty" failure mode: a catalog where every bottle
      // already has a profile is the goal, so 0 work is ok.
      await writeSummary({
        source: "enrich",
        status: "ok",
        scanned: report.candidates,
        candidates: report.fromNotes + report.fromAi,
        dryRun: report.dryRun,
        message: `${report.fromNotes} profiles from user notes, ${report.fromAi} from the model, ${report.rejected} rejected${limit != null ? ` (limit ${limit})` : ""}`,
      });
    } catch (err) {
      await writeSummary({ source: "enrich", status: "failed", message: err instanceof Error ? err.message : String(err) });
      if (err instanceof AiNotConfiguredError) {
        console.error(
          "No AI key is set. Set OPENROUTER_API_KEY (preferred) or ANTHROPIC_API_KEY (see .env.example) and re-run: pnpm ingest enrich",
        );
        process.exit(1);
      }
      throw err;
    }
    return;
  }

  if (source === "prune") {
    const removed = await pruneImportedBottles(db);
    console.log(`Pruned ${removed} imported bottles (user-referenced bottles kept).`);
    return;
  }

  const fetchers: Record<string, { label: string; run: () => Promise<{ scanned: number; candidates: CatalogCandidates }> }> = {
    iowa: { label: "Iowa Liquor Products dataset", run: () => fetchIowaCandidates() },
    oregon: { label: "Oregon OLCC monthly pricing", run: () => fetchOregonCandidates() },
    utah: { label: "Utah DABS product list", run: () => fetchUtahCandidates() },
    bc: { label: "BC Liquor price list", run: () => fetchBcCandidates() },
    systembolaget: { label: "Systembolaget assortment mirror", run: () => fetchSystembolagetCandidates() },
    whiskyedition: { label: "WHISKY:EDITION review catalog", run: () => fetchWhiskyEditionCandidates() },
    vinmonopolet: {
      label: "Vinmonopolet products API (needs VINMONOPOLET_API_KEY)",
      run: () => fetchVinmonopoletCandidates(),
    },
    cola: {
      label: "TTB COLA whiskey approvals",
      run: async () => {
        const since = hasFlag("full") ? COLA_FULL_HISTORY_START : arg("since");
        const until = arg("until") ?? new Date().toISOString().slice(0, 10);
        if (!since) {
          console.error("cola requires --since YYYY-MM-DD or --full (backfill from 1999-01-01)");
          process.exit(1);
        }
        console.log(`  range ${since}..${until}${hasFlag("full") ? " (full history)" : ""}`);
        return colaRecordsToCandidates(await fetchColaRecords({ since, until }));
      },
    },
  };

  if (source && source in fetchers) {
    const entry = fetchers[source];
    const before = await countBottles(db);
    const started = Date.now();
    console.log(`Downloading ${entry.label}…`);
    let summary: SourceRunSummary;
    try {
      const { scanned, candidates } = await entry.run();
      const report = await ingestCandidates(db, source, candidates, { dryRun, scanned });
      const after = await countBottles(db);
      printReport(report, before, after);
      summary = summaryFromReport(report, {
        catalogBefore: before,
        catalogAfter: after,
        durationMs: Date.now() - started,
        allowEmpty: hasFlag("allow-empty"),
      });
      if (summary.status === "empty") {
        annotate("error", `[${source}] ${summary.message}`);
        process.exitCode = 1;
      }
    } catch (err) {
      const unavailable = err instanceof SourceUnavailableError;
      summary = {
        source,
        status: unavailable ? "degraded" : "failed",
        catalogBefore: before,
        catalogAfter: before,
        durationMs: Date.now() - started,
        message: describeError(err),
        dryRun,
      };
      await writeSummary(summary);
      if (!unavailable) throw err;
      // Not ours to fix: report it, keep the run going, exit 0.
      annotate("warning", `[${source}] source unavailable — ${summary.message}`);
      return;
    }
    await writeSummary(summary);
    return;
  }

  console.error(
    "Usage: pnpm ingest <iowa|cola|oregon|utah|bc|systembolaget|whiskyedition|vinmonopolet|resources|enrich|prune> [--manifest FILE] [--apply] [--since YYYY-MM-DD|--full] [--until YYYY-MM-DD] [--limit N] [--batch-size N] [--no-web] [--dry-run]",
  );
  process.exit(1);
}

type CatalogCandidates = Parameters<typeof ingestCandidates>[2];

/** One line for the summary: undici's "fetch failed" hides the useful part in `cause`. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
}

/** A GitHub Actions annotation when running there; a plain log line otherwise. */
function annotate(level: "warning" | "error", message: string): void {
  if (process.env.GITHUB_ACTIONS) console.log(`::${level}::${message}`);
  else console[level === "error" ? "error" : "warn"](message);
}

/** Persist the run summary when --summary FILE was given. */
async function writeSummary(summary: SourceRunSummary): Promise<void> {
  const path = arg("summary");
  if (!path) return;
  await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function printReport(
  report: IngestReport,
  before: number,
  after: number,
): void {
  console.log(
    `[${report.source}]${report.dryRun ? " (dry run)" : ""} scanned ${report.scanned} rows → ` +
      `${report.candidates} candidates: ${report.matchedExisting} matched existing, ` +
      `${report.inserted} new bottles, ${report.upcsAdded} new barcodes. ` +
      `Catalog: ${before} → ${after} bottles.`,
  );
}

main()
  // Every source can change the verified catalog (resource manifests promote
  // bottles; prune and sync reshape it), so the cached passport denominators
  // are recounted once the run is over — the refresh rule in
  // src/lib/catalog-totals.ts. One grouped scan; cheap next to any ingest.
  .then(async () => {
    if (ingestDb && !hasFlag("dry-run")) await refreshCatalogTotals(ingestDb);
  })
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

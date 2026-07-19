/**
 * Catalog ingestion CLI (docs/DATA_SOURCES.md §2, §6). Runs against
 * DATABASE_URL, same bootstrapping as db:seed.
 *
 *   pnpm ingest iowa [--dry-run]
 *   pnpm ingest cola --since 2026-01-01 [--until 2026-07-01] [--dry-run]
 *   pnpm ingest enrich [--limit N] [--batch-size N] [--dry-run]
 *   pnpm ingest prune            # delete imported bottles untouched by users
 *
 * Sources:
 *   iowa   — Iowa Liquor Products open dataset (CC-BY 4.0): names, categories,
 *            ABV, 750ml state retail price, UPCs. Full-catalog sync, ~4k
 *            whiskey SKUs; safe to re-run monthly (the feed updates monthly).
 *   cola   — TTB public COLA registry: newly label-approved whiskies (name +
 *            category only). Date-ranged; run e.g. weekly with a short window.
 *   enrich — AI pass filling flavor-wheel profiles for bottles without one
 *            (imported/user-submitted), making them recommendable. Requires
 *            ANTHROPIC_API_KEY; batches ~25 bottles per request.
 */
import { createDb, resolveDbUrl } from "../src/db";
import { migrateDb } from "../src/db/migrate";
import {
  countBottles,
  enrichBottleProfiles,
  enrichModel,
  fetchColaRecords,
  colaRecordsToCandidates,
  fetchIowaCandidates,
  ingestCandidates,
  pruneImportedBottles,
} from "../src/lib/ingest";
import { AiNotConfiguredError } from "../src/lib/ai/client";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const source = process.argv[2];
  const dryRun = hasFlag("dry-run");
  const url = resolveDbUrl();
  const db = createDb(url);
  await migrateDb(db, url);

  if (source === "enrich") {
    const limit = arg("limit") ? Number(arg("limit")) : undefined;
    const batchSize = arg("batch-size") ? Number(arg("batch-size")) : undefined;
    try {
      console.log(`Enriching flavor profiles with ${enrichModel()}…`);
      const report = await enrichBottleProfiles(db, {
        limit,
        batchSize,
        dryRun,
        onBatch: (batch, enriched) => console.log(`  batch ${batch}: ${enriched} enriched so far`),
      });
      console.log(
        `[enrich]${report.dryRun ? " (dry run)" : ""} ${report.candidates} bottles without profiles → ` +
          `${report.enriched} enriched, ${report.rejected} rejected across ${report.batches} batches.`,
      );
    } catch (err) {
      if (err instanceof AiNotConfiguredError) {
        console.error(
          "ANTHROPIC_API_KEY is not set. Set it (see .env.example) and re-run: pnpm ingest enrich",
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

  const before = await countBottles(db);

  if (source === "iowa") {
    console.log("Downloading Iowa Liquor Products dataset…");
    const { scanned, candidates } = await fetchIowaCandidates();
    const report = await ingestCandidates(db, "iowa", candidates, { dryRun, scanned });
    printReport(report, before, await countBottles(db));
    return;
  }

  if (source === "cola") {
    const since = arg("since");
    const until = arg("until") ?? new Date().toISOString().slice(0, 10);
    if (!since) {
      console.error("cola requires --since YYYY-MM-DD (e.g. the date of the last sync)");
      process.exit(1);
    }
    console.log(`Fetching TTB COLA whisky approvals ${since}..${until}…`);
    const records = await fetchColaRecords({ since, until });
    const { scanned, candidates } = colaRecordsToCandidates(records);
    const report = await ingestCandidates(db, "cola", candidates, { dryRun, scanned });
    printReport(report, before, await countBottles(db));
    return;
  }

  console.error(
    "Usage: pnpm ingest <iowa|cola|enrich|prune> [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit N] [--batch-size N] [--dry-run]",
  );
  process.exit(1);
}

function printReport(
  report: Awaited<ReturnType<typeof ingestCandidates>>,
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
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

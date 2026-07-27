/**
 * Catalog ingestion CLI (docs/DATA_SOURCES.md §2, §6). Runs against
 * DATABASE_URL, same bootstrapping as db:seed.
 *
 *   pnpm ingest iowa [--dry-run]
 *   pnpm ingest cola --since 2026-01-01 [--until 2026-07-01] [--dry-run]
 *   pnpm ingest cola --full [--until 2026-07-01] [--dry-run]
 *   pnpm ingest oregon|utah|bc|systembolaget|whiskyedition [--dry-run]
 *   pnpm ingest enrich [--limit N] [--batch-size N] [--no-web] [--dry-run]
 *   pnpm ingest prune            # delete imported bottles untouched by users
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
 *   enrich — fills flavor-wheel profiles for bottles without one
 *            (imported/user-submitted), making them recommendable. Bottles
 *            with enough user tasting notes are rolled up directly (no AI);
 *            the rest go to the model with description + user-note context
 *            and web search to discover published tasting notes (requires
 *            OPENROUTER_API_KEY or ANTHROPIC_API_KEY). OpenRouter uses its
 *            Anthropic-compatible Messages API but does not accept Anthropic
 *            hosted web search, so --no-web is implied there.
 */
import { createDb, resolveDbUrl } from "../src/db";
import { migrateDb } from "../src/db/migrate";
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
  fetchWhiskyEditionCandidates,
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
    } catch (err) {
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

  const before = await countBottles(db);

  if (source === "iowa") {
    console.log("Downloading Iowa Liquor Products dataset…");
    const { scanned, candidates } = await fetchIowaCandidates();
    const report = await ingestCandidates(db, "iowa", candidates, { dryRun, scanned });
    printReport(report, before, await countBottles(db));
    return;
  }

  const simpleSources = {
    oregon: { label: "Oregon OLCC monthly pricing", fetch: fetchOregonCandidates },
    utah: { label: "Utah DABS product list", fetch: fetchUtahCandidates },
    bc: { label: "BC Liquor price list", fetch: fetchBcCandidates },
    systembolaget: { label: "Systembolaget assortment mirror", fetch: fetchSystembolagetCandidates },
    whiskyedition: { label: "WHISKY:EDITION review catalog", fetch: fetchWhiskyEditionCandidates },
  } as const;
  if (source && source in simpleSources) {
    const entry = simpleSources[source as keyof typeof simpleSources];
    console.log(`Downloading ${entry.label}…`);
    const { scanned, candidates } = await entry.fetch();
    const report = await ingestCandidates(db, source, candidates, { dryRun, scanned });
    printReport(report, before, await countBottles(db));
    return;
  }

  if (source === "cola") {
    const since = hasFlag("full") ? COLA_FULL_HISTORY_START : arg("since");
    const until = arg("until") ?? new Date().toISOString().slice(0, 10);
    if (!since) {
      console.error("cola requires --since YYYY-MM-DD or --full (backfill from 1999-01-01)");
      process.exit(1);
    }
    console.log(`Fetching TTB COLA whiskey approvals ${since}..${until}${hasFlag("full") ? " (full history)" : ""}…`);
    const records = await fetchColaRecords({ since, until });
    const { scanned, candidates } = colaRecordsToCandidates(records);
    const report = await ingestCandidates(db, "cola", candidates, { dryRun, scanned });
    printReport(report, before, await countBottles(db));
    return;
  }

  console.error(
    "Usage: pnpm ingest <iowa|cola|oregon|utah|bc|systembolaget|whiskyedition|enrich|prune> [--since YYYY-MM-DD|--full] [--until YYYY-MM-DD] [--limit N] [--batch-size N] [--no-web] [--dry-run]",
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

/**
 * Brand/distillery logo backfill (docs/DATA_SOURCES.md §5.4).
 *
 *   pnpm logos                       # dry run: plan + lookups, no writes
 *   pnpm logos --apply [--limit 150] [--max-age-days 30] [--force] [--summary FILE]
 *
 * Runs in GitHub Actions (.github/workflows/brand-logos.yml) against the
 * DATABASE_URL secret — never on a developer host. Idempotent: bottles are
 * re-filed only when their brand changes, and a brand's mark is looked up
 * again only when it was never checked or was checked > max-age days ago.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeDb, createDb, resolveDbUrl } from "../src/db";
import { formatDbError } from "../src/db/redact";
import { coverageMarkdown, runLogoBackfill, type BrandSeed } from "../src/lib/logos/backfill";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const limit = Number(arg("limit") ?? 150);
  const maxAgeDays = Number(arg("max-age-days") ?? 30);
  const summary = arg("summary");
  const seedsFile = JSON.parse(await readFile(path.join(process.cwd(), "config/brand-seeds.json"), "utf8")) as { brands: BrandSeed[] };
  const url = resolveDbUrl();
  const db = createDb(url);
  try {
    const report = await runLogoBackfill(db, {
      apply,
      force,
      limit,
      maxAgeDays,
      seeds: seedsFile.brands,
      log: (m) => console.log(m),
    });
    const md = coverageMarkdown(report);
    console.log(md);
    if (summary) await writeFile(summary, JSON.stringify(report, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, md + "\n", { flag: "a" });
  } catch (err) {
    console.error(`brand logos failed: ${formatDbError(err, url)}`);
    process.exitCode = 1;
  } finally {
    await closeDb(db);
  }
}

void main();

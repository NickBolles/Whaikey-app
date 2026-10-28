/**
 * Brand/distillery logo backfill (docs/DATA_SOURCES.md §5.4).
 *
 *   pnpm logos                       # dry run: plan + lookups, no writes
 *   pnpm logos --apply [--limit 150] [--max-age-days 30] [--force] [--clear-missing] [--summary FILE]
 *   pnpm logos --apply --reject jura,imperial [--reject-file keys.txt]
 *
 * `--reject` / `--reject-file` (comma- or newline-separated brand keys) take
 * wrong marks down for good: status `rejected`, bytes cleared, never fetched
 * again even with `--force`. A reject run does nothing else. Without
 * `--apply` it only reports what it would reject.
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
import { coverageMarkdown, logoCoverage, rejectBrandLogos, runLogoBackfill, type BrandSeed } from "../src/lib/logos/backfill";

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
  const clearMissing = process.argv.includes("--clear-missing");
  const rejectFile = arg("reject-file");
  const rejectKeys = [
    ...(arg("reject") ?? "").split(/[,\s]+/),
    ...(rejectFile ? (await readFile(rejectFile, "utf8")).split(/[,\s]+/) : []),
  ].filter(Boolean);
  const seedsFile = JSON.parse(await readFile(path.join(process.cwd(), "config/brand-seeds.json"), "utf8")) as { brands: BrandSeed[] };
  const url = resolveDbUrl();
  const db = createDb(url);
  try {
    if (rejectKeys.length > 0) {
      const res = await rejectBrandLogos(db, rejectKeys, { apply });
      const verb = apply ? "rejected" : "would reject (dry run)";
      console.log(`${verb} ${res.rejected.length}: ${res.rejected.join(", ")}`);
      if (res.created.length) console.log(`  (no row yet, placeholder ${apply ? "created" : "would be created"}: ${res.created.join(", ")})`);
      const md = [`### Brand logos — ${verb} ${res.rejected.length}`, "", res.rejected.map((k) => `\`${k}\``).join(", ")].join("\n");
      if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, md + "\n", { flag: "a" });
      if (summary && apply) {
        const coverage = await logoCoverage(db);
        await writeFile(summary, JSON.stringify({ apply, rejected: res.rejected, coverage }, null, 2));
      }
      return;
    }
    const report = await runLogoBackfill(db, {
      clearMissing,
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

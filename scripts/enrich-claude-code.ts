#!/usr/bin/env tsx
/**
 * Local, subscription-authenticated flavor-profile enrichment.
 *
 * Prerequisites:
 *   - `claude auth status --text` shows a logged-in Claude Pro/Max account
 *   - DATABASE_URL points at the intended database
 *
 * Safe first run (no DB writes, but it does consume Claude subscription usage):
 *   pnpm enrich:claude-code --dry-run --limit 25
 *
 * Apply a deliberately bounded batch:
 *   pnpm enrich:claude-code --apply --limit 25 --batch-size 5
 *
 * The runner reuses the production enrichment implementation, including
 * candidate selection, community-note rollups, profile validation, and
 * idempotent updates. It does not need an Anthropic or OpenRouter API key.
 */
import { spawnSync } from "node:child_process";
import { createDb, resolveDbUrl } from "../src/db";
import { migrateDb } from "../src/db/migrate";
import { enrichBottleProfiles } from "../src/lib/ingest/enrich";
import { makeClaudeCodeClient, runClaudeStructured } from "../src/lib/ingest/claude-code-client";
import { buildSoldVerificationPrompt, buildSoldVerificationSchema, findImportedBottles, normalizeSoldVerification, persistSoldVerification } from "../src/lib/ingest/verify-sold";

const DEFAULT_LIMIT = 25;
const DEFAULT_BATCH_SIZE = 5;

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = value(name);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function usage(): never {
  console.error(
    "Usage: pnpm enrich:claude-code (--apply | --dry-run) [--verify-sold] [--limit N] [--batch-size N]",
  );
  process.exit(1);
}

function requireClaudeCodeLogin(): void {
  const result = spawnSync("claude", ["auth", "status", "--text"], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error("Claude Code is not authenticated. Run `claude auth login` first.");
  }
}

async function main(): Promise<void> {
  const apply = hasFlag("apply");
  const dryRun = hasFlag("dry-run");
  if (apply === dryRun) usage();

  const limit = positiveInteger("limit", DEFAULT_LIMIT);
  const batchSize = positiveInteger("batch-size", DEFAULT_BATCH_SIZE);
  const url = resolveDbUrl();
  requireClaudeCodeLogin();

  if (dryRun) {
    console.warn("Dry-run still sends prompts to Claude Code and consumes subscription usage; it only skips DB writes.");
  }
  console.log(
    `Enriching up to ${limit} bottles in batches of ${batchSize} using the authenticated Claude Code subscription${dryRun ? " (dry run)" : ""}…`,
  );

  const db = createDb(url);
  await migrateDb(db, url);
  if (hasFlag("verify-sold")) {
    const candidates = await findImportedBottles(db, limit);
    let verified = 0;
    const schema = buildSoldVerificationSchema();
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const output = await runClaudeStructured({
        prompt: buildSoldVerificationPrompt(batch), schema, model: process.env.WHAIKEY_CLAUDE_CODE_MODEL,
        allowWebSearch: true,
      });
      const rows = output && typeof output === "object" && Array.isArray((output as { results?: unknown }).results)
        ? (output as { results: unknown[] }).results
        : [];
      for (const row of rows) {
        const normalized = normalizeSoldVerification(row);
        if (normalized && await persistSoldVerification(db, normalized, dryRun)) verified += 1;
      }
      console.log(`  verification batch ${Math.floor(i / batchSize) + 1}: ${verified} source-backed products`);
    }
    console.log(`[verify-sold]${dryRun ? " (dry run)" : ""} ${candidates.length} imported labels checked → ${verified} products verified.`);
    return;
  }

  const report = await enrichBottleProfiles(db, {
    limit, batchSize, web: false, dryRun,
    client: makeClaudeCodeClient({ model: process.env.WHAIKEY_CLAUDE_CODE_MODEL }),
    onBatch: (batch, enriched) => console.log(`  batch ${batch}: ${enriched} enriched so far`),
  });

  console.log(
    `[enrich:claude-code]${report.dryRun ? " (dry run)" : ""} ${report.candidates} bottles without profiles → ` +
      `${report.fromNotes} from user notes, ${report.fromAi} from Claude Code, ` +
      `${report.rejected} rejected across ${report.batches} batches.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

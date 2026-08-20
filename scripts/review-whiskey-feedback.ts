#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { closeDb, createDb, resolveDbUrl } from "../src/db";
import { migrateDb } from "../src/db/migrate";
import { bottles } from "../src/db/schema";
import { runClaudeStructured } from "../src/lib/ingest/claude-code-client";
import {
  bottleIdFromReference,
  issueSection,
  reviewWhiskeyFeedback,
  type WhiskeyFeedbackIssue,
} from "../src/lib/ingest/feedback-review";
import { resolveModel } from "../src/lib/ingest/verification-queue";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function requireClaudeCodeLogin(): void {
  const result = spawnSync("claude", ["auth", "status", "--text"], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error("Claude Code is not authenticated. This workflow never falls back to an API key.");
  }
}

function readIssue(file: string): WhiskeyFeedbackIssue {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WhiskeyFeedbackIssue>;
  if (!Number.isInteger(parsed.number) || typeof parsed.title !== "string" || typeof parsed.body !== "string" ||
      typeof parsed.url !== "string" || typeof parsed.author !== "string") {
    throw new Error("Issue event file is malformed");
  }
  return parsed as WhiskeyFeedbackIssue;
}

function writeArtifacts(issue: WhiskeyFeedbackIssue, payload: unknown, markdown: string): void {
  const directory = path.join(process.cwd(), "artifacts", "feedback-runs");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `issue-${issue.number}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(directory, `issue-${issue.number}.md`), markdown);
}

async function main(): Promise<void> {
  const issueFile = value("issue");
  const dryRun = hasFlag("dry-run");
  const apply = hasFlag("apply");
  if (!issueFile || dryRun === apply) {
    throw new Error("Usage: pnpm feedback:review --issue <event.json> (--dry-run | --apply) [--model sonnet]");
  }
  const issue = readIssue(issueFile);
  const reference = issueSection(issue.body, "Bottle ID or URL");
  if (!reference) throw new Error("Feedback issue is missing Bottle ID or URL");
  const bottleId = bottleIdFromReference(reference);
  const databaseUrl = resolveDbUrl();
  const db = createDb(databaseUrl);
  try {
    await migrateDb(db, databaseUrl);
    const [bottle] = await db.select({ id: bottles.id, name: bottles.name }).from(bottles)
      .where(eq(bottles.id, bottleId)).limit(1);
    if (!bottle) throw new Error(`Unknown bottle id: ${bottleId}`);

    if (dryRun) {
      const report = { issue: issue.number, bottle, apply: false, modelCalled: false };
      writeArtifacts(issue, report, [
        "## Whiskey catalog feedback preview",
        "",
        `Validated **${bottle.name}** (\`${bottle.id}\`).`,
        "",
        "Dry run only: no subscription call and no catalog writes were made.",
      ].join("\n"));
      console.log(JSON.stringify(report));
      return;
    }

    requireClaudeCodeLogin();
    const model = resolveModel(value("model") ?? "sonnet");
    const result = await reviewWhiskeyFeedback(db, issue, {
      apply: true,
      model,
      claudeRunner: runClaudeStructured,
    });
    const markdown = [
      "## AI catalog review complete",
      "",
      `Reviewed **${result.bottle.name}** (\`${result.bottle.id}\`) using the authenticated Claude Code subscription lane.`,
      "",
      result.summary,
      "",
      `Validated ${result.manifest.resources.length} source(s); wrote ${result.ingestion.resourcesWritten} resource(s), ${result.ingestion.claimsWritten} claim(s), and ${result.ingestion.mediaWritten} media reference(s).`,
      "",
      ...result.manifest.resources.map((resource) => `- [${resource.title ?? resource.resourceType}](${resource.url}) — ${resource.resourceType}`),
      "",
      "The AI only discovered candidate URLs; Whaikey's deterministic source parser and provenance rules controlled every catalog write.",
    ].join("\n");
    writeArtifacts(issue, result, markdown);
    console.log(JSON.stringify({ issue: issue.number, bottle: result.bottle, ingestion: result.ingestion }));
  } finally {
    await closeDb(db);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { eq, inArray } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles, bottleUpcs, catalogVerificationWork, type VerificationAttemptOutcome, type VerificationWork, type VerificationWorkStatus } from "@/db/schema";
import {
  buildSoldVerificationPrompt,
  buildSoldVerificationSchema,
  normalizeSoldVerification,
  persistSoldVerification,
  type SoldVerification,
  type VerificationCandidate,
} from "@/lib/ingest/verify-sold";
import { assertWorkerCount, claimWork, finalizeWork } from "@/lib/ingest/verification-queue";

/**
 * Worker execution phase for the durable catalog verification queue
 * (src/lib/ingest/verification-queue.ts). The queue module owns claim/lease/
 * finalize mechanics; this module owns turning a claimed batch into exactly
 * one durable outcome per bottle by calling an authenticated Claude Code CLI
 * subscription (never an API key — see src/lib/ingest/claude-code-client.ts,
 * injected here as `claudeRunner` so this module never spawns a process or
 * imports the API-key-based client itself).
 *
 * Every finalize call goes through `finalizeWork`, which only succeeds while
 * the row is still leased under the exact token this worker holds — a lease
 * that expired and was reclaimed by someone else silently no-ops here rather
 * than double-writing.
 */

// ---------------------------------------------------------------------------
// Claude runner seam
// ---------------------------------------------------------------------------

/** Matches the surface of runClaudeStructured (src/lib/ingest/claude-code-client.ts) — injected so tests never spawn the real CLI. */
export type ClaudeStructuredRunner = (options: {
  prompt: string;
  schema: Record<string, unknown>;
  model?: string;
  allowWebSearch?: boolean;
}) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Candidate facts (loads exact candidate data + UPCs for claimed rows)
// ---------------------------------------------------------------------------

interface CandidateFacts extends VerificationCandidate {
  upcs: string[];
}

async function loadCandidateFacts(db: DB, bottleIds: string[]): Promise<Map<string, CandidateFacts>> {
  const out = new Map<string, CandidateFacts>();
  if (!bottleIds.length) return out;

  const rows = await db
    .select({ id: bottles.id, name: bottles.name, category: bottles.category, region: bottles.region, abv: bottles.abv, ageYears: bottles.ageYears })
    .from(bottles)
    .where(inArray(bottles.id, bottleIds));
  if (!rows.length) return out;

  const upcRows = await db
    .select({ bottleId: bottleUpcs.bottleId, upc: bottleUpcs.upc })
    .from(bottleUpcs)
    .where(inArray(bottleUpcs.bottleId, bottleIds));
  const upcsByBottle = new Map<string, string[]>();
  for (const row of upcRows) {
    const list = upcsByBottle.get(row.bottleId) ?? [];
    list.push(row.upc);
    upcsByBottle.set(row.bottleId, list);
  }

  for (const row of rows) out.set(row.id, { ...row, upcs: upcsByBottle.get(row.id) ?? [] });
  return out;
}

// ---------------------------------------------------------------------------
// Reconciliation (pure — exercised directly in tests)
// ---------------------------------------------------------------------------

export type ReconciledItem =
  | { status: "ok"; item: Record<string, unknown> }
  | { status: "missing" }
  | { status: "duplicate"; count: number };

/**
 * Reconcile Claude's `results` array against the exact set of ids we asked
 * about: every expected id gets exactly one entry in the returned map,
 * whether or not Claude actually answered for it. An id in `results` that
 * doesn't match an expected id (unrequested/malformed id) is silently
 * dropped — there is no leased row it could be attributed to.
 */
export function reconcileClaudeResults(expectedIds: string[], results: unknown[]): Map<string, ReconciledItem> {
  const expected = new Set(expectedIds);
  const byId = new Map<string, Record<string, unknown>[]>();
  for (const raw of results) {
    if (!raw || typeof raw !== "object") continue;
    const id = (raw as Record<string, unknown>).id;
    if (typeof id !== "string" || !expected.has(id)) continue;
    const list = byId.get(id) ?? [];
    list.push(raw as Record<string, unknown>);
    byId.set(id, list);
  }

  const out = new Map<string, ReconciledItem>();
  for (const id of expectedIds) {
    const group = byId.get(id) ?? [];
    if (group.length === 0) out.set(id, { status: "missing" });
    else if (group.length > 1) out.set(id, { status: "duplicate", count: group.length });
    else out.set(id, { status: "ok", item: group[0] });
  }
  return out;
}

export type ClassifiedItem =
  | { outcome: "verified"; normalized: SoldVerification }
  | { outcome: "not_evidenced" }
  | { outcome: "retry"; reason: string };

/** Classify one reconciled `{status: "ok"}` item into a queue outcome. Never mutates anything. */
export function classifySoldItem(item: Record<string, unknown>): ClassifiedItem {
  if (item.sold === false) return { outcome: "not_evidenced" };
  if (item.sold === true) {
    const normalized = normalizeSoldVerification(item);
    if (normalized) return { outcome: "verified", normalized };
    return { outcome: "retry", reason: "sold=true without valid non-TTB evidence" };
  }
  return { outcome: "retry", reason: "malformed item: sold is not a boolean" };
}

// ---------------------------------------------------------------------------
// Batch processing (one Claude call per claimed batch, one worker at a time)
// ---------------------------------------------------------------------------

export interface BatchOutcome {
  bottleId: string;
  outcome: VerificationAttemptOutcome;
  detail?: string;
  finalized: boolean;
  status?: VerificationWorkStatus;
}

interface FinalizeArgs {
  runId: string;
  worker: string;
  partition: number;
}

async function finalize(
  db: DB,
  row: VerificationWork,
  args: FinalizeArgs,
  outcome: VerificationAttemptOutcome,
  error: string | null,
  evidence: Record<string, unknown> | null,
  fact: CandidateFacts | undefined,
): Promise<BatchOutcome> {
  const inputSnapshot = fact
    ? { name: fact.name, category: fact.category, region: fact.region, abv: fact.abv, ageYears: fact.ageYears, upcs: fact.upcs }
    : {};
  const result = await finalizeWork(db, {
    bottleId: row.bottleId,
    leaseToken: row.leaseToken!,
    runId: args.runId,
    worker: args.worker,
    partition: args.partition,
    inputSnapshot,
    outcome,
    evidence,
    error,
  });
  return { bottleId: row.bottleId, outcome, detail: error ?? undefined, finalized: result.finalized, status: result.status };
}

/**
 * Re-check the lease immediately before a bottle-mutating write. finalizeWork
 * already gates the *queue* row on an exact lease-token match, but that check
 * happens after persistSoldVerification would already have run — without
 * this, a stale/reclaimed lease could still mutate `bottles` even though the
 * queue finalize that follows is correctly rejected as a no-op.
 */
async function leaseStillActive(db: DB, bottleId: string, leaseToken: string): Promise<boolean> {
  const [row] = await db
    .select({ status: catalogVerificationWork.status, leaseToken: catalogVerificationWork.leaseToken })
    .from(catalogVerificationWork)
    .where(eq(catalogVerificationWork.bottleId, bottleId))
    .limit(1);
  return !!row && row.status === "leased" && row.leaseToken === leaseToken;
}

export interface ProcessBatchOptions {
  runId: string;
  worker: string;
  partition: number;
  model: string;
  claudeRunner: ClaudeStructuredRunner;
}

/**
 * Turn one claimed batch into exactly one finalize call per row. A single
 * Claude call covers the whole batch (buildSoldVerificationPrompt already
 * expects "one result per supplied id"); CLI-level failures and malformed
 * top-level shapes fall back to per-row finalize calls so every claimed row
 * still gets a durable, ledgered outcome even when Claude never responds
 * usefully.
 */
export async function processClaimedBatch(db: DB, claimed: VerificationWork[], opts: ProcessBatchOptions): Promise<BatchOutcome[]> {
  if (!claimed.length) return [];

  const facts = await loadCandidateFacts(db, claimed.map((c) => c.bottleId));
  const outcomes: BatchOutcome[] = [];

  const missing = claimed.filter((c) => !facts.has(c.bottleId));
  for (const row of missing) {
    outcomes.push(await finalize(db, row, opts, "error", "bottle record not found for leased work item", null, undefined));
  }

  const present = claimed.filter((c) => facts.has(c.bottleId));
  if (!present.length) return outcomes;

  const candidateRows: VerificationCandidate[] = present.map((c) => {
    const fact = facts.get(c.bottleId)!;
    return { id: fact.id, name: fact.name, category: fact.category, region: fact.region, abv: fact.abv, ageYears: fact.ageYears };
  });

  let raw: unknown;
  try {
    raw = await opts.claudeRunner({
      prompt: buildSoldVerificationPrompt(candidateRows),
      schema: buildSoldVerificationSchema(),
      model: opts.model,
      allowWebSearch: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const row of present) {
      outcomes.push(await finalize(db, row, opts, "error", message, null, facts.get(row.bottleId)));
    }
    return outcomes;
  }

  const results =
    raw && typeof raw === "object" && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : null;

  if (!results) {
    for (const row of present) {
      outcomes.push(await finalize(db, row, opts, "retry", "malformed Claude response: no results array", null, facts.get(row.bottleId)));
    }
    return outcomes;
  }

  const reconciled = reconcileClaudeResults(present.map((c) => c.bottleId), results);
  for (const row of present) {
    const fact = facts.get(row.bottleId);
    const rec = reconciled.get(row.bottleId)!;

    if (rec.status === "missing") {
      outcomes.push(await finalize(db, row, opts, "retry", "missing from Claude response", null, fact));
      continue;
    }
    if (rec.status === "duplicate") {
      outcomes.push(await finalize(db, row, opts, "retry", `duplicate id in Claude response (n=${rec.count})`, null, fact));
      continue;
    }

    const classified = classifySoldItem(rec.item);
    if (classified.outcome === "verified") {
      if (!(await leaseStillActive(db, row.bottleId, row.leaseToken!))) {
        outcomes.push({ bottleId: row.bottleId, outcome: "verified", finalized: false, detail: "lease no longer active; skipped bottle write" });
        continue;
      }
      const persisted = await persistSoldVerification(db, classified.normalized, false);
      if (!persisted) {
        outcomes.push(await finalize(db, row, opts, "retry", "bottle no longer eligible for verification", null, fact));
      } else {
        outcomes.push(await finalize(db, row, opts, "verified", null, classified.normalized as unknown as Record<string, unknown>, fact));
      }
    } else if (classified.outcome === "not_evidenced") {
      outcomes.push(await finalize(db, row, opts, "not_evidenced", null, { sold: false }, fact));
    } else {
      outcomes.push(await finalize(db, row, opts, "retry", classified.reason, null, fact));
    }
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// Bounded-concurrency worker pool
// ---------------------------------------------------------------------------

export interface RunWorkersOptions {
  runId: string;
  workers: number;
  batchSize: number;
  /** Total rows this invocation may claim+process, split across `workers` — a bounded batch, not a poll loop. */
  leaseCap: number;
  model: string;
  claudeRunner: ClaudeStructuredRunner;
  leaseMs?: number;
  now?: Date;
}

export interface RunWorkersResult {
  leased: number;
  outcomes: BatchOutcome[];
}

/**
 * Run up to `workers` concurrent claim→Claude→reconcile loops in-process,
 * each awaiting its own Claude call before claiming again (one in-flight
 * Claude invocation per worker). Budget reservation happens synchronously
 * (no `await` between the check and the decrement) so concurrent loops can
 * never jointly claim more than `leaseCap` rows even though claimWork itself
 * is called after an await. This performs exactly one bounded pass — it never
 * re-polls once the budget or the eligible queue is exhausted.
 */
export async function runVerificationWorkers(db: DB, opts: RunWorkersOptions): Promise<RunWorkersResult> {
  assertWorkerCount(opts.workers);
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) throw new Error("batchSize must be a positive integer");
  if (!Number.isInteger(opts.leaseCap) || opts.leaseCap < 0) throw new Error("leaseCap must be a non-negative integer");

  let remaining = opts.leaseCap;
  let leased = 0;
  const outcomes: BatchOutcome[] = [];

  async function workerLoop(index: number): Promise<void> {
    const worker = `worker-${index}`;
    for (;;) {
      if (remaining <= 0) return;
      const take = Math.min(opts.batchSize, remaining);
      remaining -= take; // reserved synchronously before the first await below

      const claimed = await claimWork(db, {
        runId: opts.runId,
        worker,
        partition: index,
        batchSize: take,
        leaseMs: opts.leaseMs,
        now: opts.now,
      });
      if (claimed.length < take) remaining += take - claimed.length; // give back unused reservation
      if (!claimed.length) return; // nothing left eligible

      leased += claimed.length;
      const batchOutcomes = await processClaimedBatch(db, claimed, {
        runId: opts.runId,
        worker,
        partition: index,
        model: opts.model,
        claudeRunner: opts.claudeRunner,
      });
      outcomes.push(...batchOutcomes);
    }
  }

  await Promise.all(Array.from({ length: opts.workers }, (_, index) => workerLoop(index)));

  return { leased, outcomes };
}

// ---------------------------------------------------------------------------
// Report summary (pure — used to build the checkpoint JSON report)
// ---------------------------------------------------------------------------

export interface WorkerRunReport {
  leased: number;
  verified: number;
  notEvidenced: number;
  retryable: number;
  rejected: number;
  errors: number;
}

/** Tally one invocation's outcomes into the report shape (scanned/queue-level fields are layered on by the caller). */
export function summarizeWorkerOutcomes(outcomes: BatchOutcome[]): WorkerRunReport {
  const report: WorkerRunReport = { leased: outcomes.length, verified: 0, notEvidenced: 0, retryable: 0, rejected: 0, errors: 0 };
  for (const outcome of outcomes) {
    if (outcome.status === "verified") report.verified += 1;
    else if (outcome.status === "not_evidenced") report.notEvidenced += 1;
    else if (outcome.status === "retry_wait") report.retryable += 1;
    else if (outcome.status === "failed_terminal") report.rejected += 1;
    if (outcome.outcome === "error") report.errors += 1;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Preflight smoke probe (tiny structured-output round trip before production work)
// ---------------------------------------------------------------------------

export function buildSmokeProbeSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { pong: { type: "boolean" }, model: { type: "string" } },
    required: ["pong", "model"],
    additionalProperties: false,
  };
}

export function buildSmokeProbePrompt(): string {
  return (
    'Respond only with the JSON object {"pong": true, "model": "<your exact model name>"} to confirm the CLI ' +
    "and model are reachable. Do not search the web or use any tools."
  );
}

export function isValidSmokeProbeOutput(value: unknown, expectedModel?: string): boolean {
  if (!value || typeof value !== "object") return false;
  const output = value as Record<string, unknown>;
  return output.pong === true
    && typeof output.model === "string"
    && (expectedModel == null || output.model === expectedModel);
}

export interface SmokeProbeResult {
  ok: boolean;
  model: string;
  output?: unknown;
  error?: string;
}

/** One trivial structured-output round trip against the authenticated CLI — no web search, no DB access, no bottle data. */
export async function runSmokeProbe(claudeRunner: ClaudeStructuredRunner, model: string): Promise<SmokeProbeResult> {
  try {
    const output = await claudeRunner({ prompt: buildSmokeProbePrompt(), schema: buildSmokeProbeSchema(), model });
    return { ok: isValidSmokeProbeOutput(output, model), model, output };
  } catch (err) {
    return { ok: false, model, error: err instanceof Error ? err.message : String(err) };
  }
}

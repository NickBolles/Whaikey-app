import { randomUUID, createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte } from "drizzle-orm";
import type { DB } from "@/db";
import {
  bottles,
  bottleUpcs,
  catalogVerificationAttempts,
  catalogVerificationRuns,
  catalogVerificationWork,
  type UpcSource,
  type VerificationAttemptOutcome,
  type VerificationRun,
  type VerificationRunMode,
  type VerificationWork,
  type VerificationWorkStatus,
} from "@/db/schema";
import { isValidUpc } from "@/lib/upc";

/**
 * Durable, subscription-only bulk catalog verification queue.
 *
 * Replaces repeated `WHERE status = 'imported'` batch selection (which keeps
 * re-selecting bottles that already came back with no evidence) with a
 * per-bottle work row that durably records queue state, priority, lease
 * ownership, and an auditable attempt ledger. This module owns queue
 * mechanics only — it never mutates `bottles` (see docs/DATA_SOURCES.md and
 * src/lib/ingest/verify-sold.ts for the bottle-promotion path that does).
 */

// ---------------------------------------------------------------------------
// Model pinning
// ---------------------------------------------------------------------------

/** Operator-facing aliases pinned to concrete model ids (never drift silently). */
export const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
  haiku: "claude-haiku-4-5-20251001",
  fable: "claude-fable-5",
};

/** Resolve an operator-supplied `--model` value to a pinned concrete model id. */
export function resolveModel(requested: string): string {
  return MODEL_ALIASES[requested.trim().toLowerCase()] ?? requested;
}

// ---------------------------------------------------------------------------
// Worker safety cap
// ---------------------------------------------------------------------------

/** Hard ceiling on concurrent workers per run. Ten is an explicit operator-approved throughput-test cap. */
export const MAX_WORKERS = 10;

export function assertWorkerCount(workers: number): void {
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error("workers must be a positive integer");
  }
  if (workers > MAX_WORKERS) {
    throw new Error(`workers (${workers}) exceeds the safety cap of ${MAX_WORKERS}`);
  }
}

// ---------------------------------------------------------------------------
// Priority + fingerprint (pure, no DB)
// ---------------------------------------------------------------------------

const PRIORITY_BASE = 100;
const AMBIGUOUS_NAME_MARKERS = /\b(assorted|variety|sampler|misc(ellaneous)?|unknown|unlabeled|no name)\b/i;

/** Names too generic to confidently match against a single retail product page. */
export function isAmbiguousName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 8) return true;
  if (AMBIGUOUS_NAME_MARKERS.test(trimmed)) return true;
  if (!/[a-z]/i.test(trimmed)) return true;
  return false;
}

export interface PriorityCandidate {
  name: string;
  region: string | null;
  abv: number | null;
  ageYears: number | null;
  upcs: Array<{ upc: string; source: UpcSource }>;
}

/**
 * Deterministic claim priority (ascending — lower claims first) plus the
 * reason codes that produced it, so an operator can see why a row was
 * prioritized without re-deriving it. Reflects search cost, not business
 * importance: a candidate with a checkable UPC and complete facts is cheap to
 * verify, so it goes first.
 */
export function computeCandidatePriority(candidate: PriorityCandidate): {
  priority: number;
  reasonCodes: string[];
} {
  let priority = PRIORITY_BASE;
  const reasonCodes: string[] = [];

  const validUpcs = candidate.upcs.filter((u) => isValidUpc(u.upc));
  if (validUpcs.length > 0) {
    priority -= 20;
    reasonCodes.push("valid_upc");
  }
  if (validUpcs.some((u) => u.source === "iowa")) {
    priority -= 10;
    reasonCodes.push("iowa_upc");
  }

  const factsComplete = candidate.abv != null && candidate.ageYears != null && candidate.region != null;
  if (factsComplete) {
    priority -= 10;
    reasonCodes.push("facts_complete");
  } else {
    priority += 15;
    reasonCodes.push("facts_incomplete");
  }

  if (isAmbiguousName(candidate.name)) {
    priority += 25;
    reasonCodes.push("name_ambiguous");
  }

  return { priority: Math.max(0, priority), reasonCodes };
}

export interface FingerprintCandidate {
  name: string;
  category: string;
  region: string | null;
  abv: number | null;
  ageYears: number | null;
  upcs: string[];
}

/** sha256 over the candidate's stable identity/fact fields — detects re-imports whose facts changed. */
export function computeCandidateFingerprint(candidate: FingerprintCandidate): string {
  const payload = JSON.stringify({
    name: candidate.name,
    category: candidate.category,
    region: candidate.region,
    abv: candidate.abv,
    ageYears: candidate.ageYears,
    upcs: [...candidate.upcs].sort(),
  });
  return createHash("sha256").update(payload).digest("hex");
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export interface CreateRunOptions {
  mode: VerificationRunMode;
  requestedModel: string;
  workers: number;
  batchSize: number;
  limit: number;
  partitions: number;
  config?: Record<string, unknown>;
}

export async function createVerificationRun(db: DB, opts: CreateRunOptions): Promise<VerificationRun> {
  assertWorkerCount(opts.workers);
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) throw new Error("batchSize must be a positive integer");
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error("limit must be a positive integer");
  if (!Number.isInteger(opts.partitions) || opts.partitions < 1) throw new Error("partitions must be a positive integer");

  const [run] = await db
    .insert(catalogVerificationRuns)
    .values({
      id: randomUUID(),
      mode: opts.mode,
      status: "created",
      requestedModel: opts.requestedModel,
      resolvedModel: resolveModel(opts.requestedModel),
      workers: opts.workers,
      batchSize: opts.batchSize,
      limit: opts.limit,
      partitions: opts.partitions,
      config: opts.config ?? null,
    })
    .returning();
  return run;
}

export async function getVerificationRun(db: DB, runId: string): Promise<VerificationRun | null> {
  const [run] = await db.select().from(catalogVerificationRuns).where(eq(catalogVerificationRuns.id, runId)).limit(1);
  return run ?? null;
}

// ---------------------------------------------------------------------------
// Snapshot (enqueue)
// ---------------------------------------------------------------------------

export interface SnapshotCandidate {
  id: string;
  name: string;
  category: string;
  region: string | null;
  abv: number | null;
  ageYears: number | null;
  upcs: Array<{ upc: string; source: UpcSource }>;
  priority: number;
  reasonCodes: string[];
  fingerprint: string;
  alreadyQueued: boolean;
}

export interface SnapshotResult {
  scanned: number;
  enqueued: number;
  skippedExisting: number;
}

/** Bounded read of imported bottles + their UPCs, with priority/fingerprint computed — no writes. */
async function loadCandidates(db: DB, limit: number): Promise<SnapshotCandidate[]> {
  const rows = await db
    .select({
      id: bottles.id,
      name: bottles.name,
      category: bottles.category,
      region: bottles.region,
      abv: bottles.abv,
      ageYears: bottles.ageYears,
    })
    .from(bottles)
    .leftJoin(catalogVerificationWork, eq(catalogVerificationWork.bottleId, bottles.id))
    .where(and(eq(bottles.status, "imported"), isNull(catalogVerificationWork.bottleId)))
    .orderBy(asc(bottles.id))
    .limit(limit);
  if (!rows.length) return [];

  const bottleIds = rows.map((r) => r.id);
  const upcRows = await db
    .select({ bottleId: bottleUpcs.bottleId, upc: bottleUpcs.upc, source: bottleUpcs.source })
    .from(bottleUpcs)
    .where(inArray(bottleUpcs.bottleId, bottleIds));
  const upcsByBottle = new Map<string, Array<{ upc: string; source: UpcSource }>>();
  for (const row of upcRows) {
    const list = upcsByBottle.get(row.bottleId) ?? [];
    list.push({ upc: row.upc, source: row.source });
    upcsByBottle.set(row.bottleId, list);
  }

  const existing = new Set(
    (
      await db
        .select({ bottleId: catalogVerificationWork.bottleId })
        .from(catalogVerificationWork)
        .where(inArray(catalogVerificationWork.bottleId, bottleIds))
    ).map((r) => r.bottleId),
  );

  return rows.map((row) => {
    const upcs = upcsByBottle.get(row.id) ?? [];
    const { priority, reasonCodes } = computeCandidatePriority({ ...row, upcs });
    const fingerprint = computeCandidateFingerprint({ ...row, upcs: upcs.map((u) => u.upc) });
    return { ...row, upcs, priority, reasonCodes, fingerprint, alreadyQueued: existing.has(row.id) };
  });
}

/** Read-only preview of what `snapshotRun` would enqueue — writes nothing (used by --dry-run). */
export async function previewSnapshot(db: DB, limit: number): Promise<{ result: SnapshotResult; candidates: SnapshotCandidate[] }> {
  const candidates = await loadCandidates(db, limit);
  const enqueued = candidates.filter((c) => !c.alreadyQueued).length;
  return {
    result: { scanned: candidates.length, enqueued, skippedExisting: candidates.length - enqueued },
    candidates,
  };
}

/**
 * Enqueue imported bottles as durable work rows, bounded by `run.limit`.
 * Idempotent: a bottle already present in the queue (any status, from any
 * run) is never re-enqueued, which is what makes a "not_evidenced" outcome
 * durable — it stops being selected even though `bottles.status` is
 * unchanged. Persists the snapshot counts onto `run.summary` and advances
 * `run.status` to "ready".
 */
export async function snapshotRun(db: DB, runId: string): Promise<SnapshotResult> {
  await db
    .update(catalogVerificationRuns)
    .set({ status: "snapshotting", startedAt: new Date(), updatedAt: new Date() })
    .where(eq(catalogVerificationRuns.id, runId));

  const run = await getVerificationRun(db, runId);
  if (!run) throw new Error(`No verification run found for id ${runId}`);

  const candidates = await loadCandidates(db, run.limit);
  let enqueued = 0;
  for (const candidate of candidates) {
    if (candidate.alreadyQueued) continue;
    const inserted = await db
      .insert(catalogVerificationWork)
      .values({
        bottleId: candidate.id,
        status: "queued",
        priority: candidate.priority,
        fingerprint: candidate.fingerprint,
        reasonCodes: candidate.reasonCodes,
        attempts: 0,
        nextEligibleAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ bottleId: catalogVerificationWork.bottleId });
    if (inserted.length) enqueued += 1;
  }

  const result: SnapshotResult = { scanned: candidates.length, enqueued, skippedExisting: candidates.length - enqueued };
  const priorSummary = (run.summary ?? {}) as Record<string, unknown>;
  await db
    .update(catalogVerificationRuns)
    .set({ status: "ready", summary: { ...priorSummary, snapshot: result }, updatedAt: new Date() })
    .where(eq(catalogVerificationRuns.id, runId));

  return result;
}

// ---------------------------------------------------------------------------
// Claim (lease)
// ---------------------------------------------------------------------------

/** Default lease TTL. Expired leases self-heal back to "queued" on the next claim. */
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;

/** Retry attempts before a row is moved to the durable "failed_terminal" state. */
export const MAX_ATTEMPTS = 3;

const CLAIM_ELIGIBLE_STATUSES = ["queued", "retry_wait"] as const satisfies readonly VerificationWork["status"][];

/**
 * Return any "leased" rows whose lease has expired to "queued" so a crashed
 * or killed worker never strands a row forever. Called at the top of every
 * claim so the queue is self-healing without a separate sweep process.
 */
export async function reclaimExpiredLeases(db: DB, now: Date = new Date()): Promise<number> {
  const reclaimed = await db
    .update(catalogVerificationWork)
    .set({
      status: "queued",
      leaseToken: null,
      leaseWorker: null,
      leaseRunId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(catalogVerificationWork.status, "leased"), lt(catalogVerificationWork.leaseExpiresAt, now)))
    .returning({ bottleId: catalogVerificationWork.bottleId });
  return reclaimed.length;
}

export interface ClaimOptions {
  runId: string;
  worker: string;
  partition: number;
  batchSize: number;
  leaseMs?: number;
  now?: Date;
}

/**
 * Claim up to `batchSize` eligible rows for `worker`, tagging them with a
 * fresh lease token/run/expiry.
 *
 * Correctness does not depend on row locking during the initial SELECT: the
 * follow-up UPDATE re-checks `status IN ('queued','retry_wait')` in its WHERE
 * clause, and Postgres serializes concurrent UPDATEs to the same row — so if
 * two workers race for the same candidate set, the second UPDATE simply
 * matches fewer rows (never zero-sum-double-claims one). A worker can get a
 * smaller-than-requested batch under contention; it never gets a row another
 * worker already claimed. This holds identically on PGlite and hosted
 * Postgres, so no separate adapter is needed for either driver.
 */
export async function claimWork(db: DB, opts: ClaimOptions): Promise<VerificationWork[]> {
  const now = opts.now ?? new Date();
  await reclaimExpiredLeases(db, now);

  const eligible = await db
    .select({ bottleId: catalogVerificationWork.bottleId })
    .from(catalogVerificationWork)
    .where(and(inArray(catalogVerificationWork.status, CLAIM_ELIGIBLE_STATUSES), lte(catalogVerificationWork.nextEligibleAt, now)))
    .orderBy(asc(catalogVerificationWork.priority), asc(catalogVerificationWork.createdAt))
    .limit(opts.batchSize);
  if (!eligible.length) return [];

  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + (opts.leaseMs ?? DEFAULT_LEASE_MS));
  const ids = eligible.map((r) => r.bottleId);

  return db
    .update(catalogVerificationWork)
    .set({
      status: "leased",
      leaseToken,
      leaseWorker: opts.worker,
      leaseRunId: opts.runId,
      leaseExpiresAt,
      updatedAt: now,
    })
    .where(
      and(
        inArray(catalogVerificationWork.bottleId, ids),
        inArray(catalogVerificationWork.status, CLAIM_ELIGIBLE_STATUSES),
        lte(catalogVerificationWork.nextEligibleAt, now),
      ),
    )
    .returning();
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

/** Exponential backoff for retry_wait eligibility: 1m, 4m, 9m, ... */
function retryBackoffMs(attempts: number): number {
  return attempts * attempts * 60_000;
}

export interface FinalizeOptions {
  bottleId: string;
  leaseToken: string;
  runId: string;
  worker: string;
  partition: number;
  inputSnapshot: Record<string, unknown>;
  outcome: VerificationAttemptOutcome;
  evidence?: Record<string, unknown> | null;
  error?: string | null;
  now?: Date;
}

export interface FinalizeResult {
  finalized: boolean;
  status?: VerificationWorkStatus;
}

/**
 * Finalize a leased row, recording the attempt permanently in the ledger.
 * Only succeeds when the row is still "leased" under exactly `leaseToken` —
 * a stale/losing caller (e.g. after its lease expired and was reclaimed) is a
 * silent no-op rather than clobbering whoever holds the row now. Never
 * touches `bottles`: a "not_evidenced" outcome moves the *work* row to a
 * durable terminal status while the bottle's catalog status is untouched.
 */
export async function finalizeWork(db: DB, opts: FinalizeOptions): Promise<FinalizeResult> {
  const now = opts.now ?? new Date();
  const [row] = await db.select().from(catalogVerificationWork).where(eq(catalogVerificationWork.bottleId, opts.bottleId)).limit(1);
  if (!row || row.status !== "leased" || row.leaseToken !== opts.leaseToken) {
    return { finalized: false };
  }

  const attempts = row.attempts + 1;
  let nextStatus: VerificationWorkStatus;
  let nextEligibleAt = now;

  if (opts.outcome === "verified") {
    nextStatus = "verified";
  } else if (opts.outcome === "not_evidenced") {
    // Durable: no evidence today does not mean retry tomorrow in this phase.
    nextStatus = "not_evidenced";
  } else if (attempts >= MAX_ATTEMPTS) {
    nextStatus = "failed_terminal";
  } else {
    nextStatus = "retry_wait";
    nextEligibleAt = new Date(now.getTime() + retryBackoffMs(attempts));
  }

  await db
    .update(catalogVerificationWork)
    .set({
      status: nextStatus,
      attempts,
      nextEligibleAt,
      leaseToken: null,
      leaseWorker: null,
      leaseRunId: null,
      leaseExpiresAt: null,
      lastOutcome: opts.outcome,
      lastError: opts.error ?? null,
      updatedAt: now,
    })
    .where(eq(catalogVerificationWork.bottleId, opts.bottleId));

  await db.insert(catalogVerificationAttempts).values({
    id: randomUUID(),
    runId: opts.runId,
    bottleId: opts.bottleId,
    leaseToken: opts.leaseToken,
    worker: opts.worker,
    partition: opts.partition,
    inputSnapshot: opts.inputSnapshot,
    outcome: opts.outcome,
    evidence: opts.evidence ?? null,
    error: opts.error ?? null,
  });

  return { finalized: true, status: nextStatus };
}

/** Pull a queued/retry_wait row out of the queue without an attempt (e.g. operator dequeue of a bad candidate). */
export async function cancelWork(db: DB, bottleId: string, reason?: string): Promise<boolean> {
  const updated = await db
    .update(catalogVerificationWork)
    .set({
      status: "cancelled",
      lastError: reason ?? null,
      leaseToken: null,
      leaseWorker: null,
      leaseRunId: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(catalogVerificationWork.bottleId, bottleId), inArray(catalogVerificationWork.status, CLAIM_ELIGIBLE_STATUSES)))
    .returning({ bottleId: catalogVerificationWork.bottleId });
  return updated.length > 0;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface RunSummary {
  runId: string;
  snapshot: SnapshotResult | null;
  attempts: { total: number; verified: number; notEvidenced: number; retry: number; error: number };
  inFlight: number;
  generatedAt: string;
}

/**
 * Recompute and persist a run's summary from the durable attempt ledger
 * (which retains `runId` even after a work row's lease is released) plus
 * currently-leased-to-this-run rows. Safe to call repeatedly (--report).
 */
export async function summarizeRun(db: DB, runId: string): Promise<RunSummary> {
  const run = await getVerificationRun(db, runId);
  if (!run) throw new Error(`No verification run found for id ${runId}`);

  const attemptRows = await db
    .select({ outcome: catalogVerificationAttempts.outcome })
    .from(catalogVerificationAttempts)
    .where(eq(catalogVerificationAttempts.runId, runId));

  const attempts = { total: attemptRows.length, verified: 0, notEvidenced: 0, retry: 0, error: 0 };
  for (const row of attemptRows) {
    if (row.outcome === "verified") attempts.verified += 1;
    else if (row.outcome === "not_evidenced") attempts.notEvidenced += 1;
    else if (row.outcome === "retry") attempts.retry += 1;
    else attempts.error += 1;
  }

  const inFlight = await db
    .select({ bottleId: catalogVerificationWork.bottleId })
    .from(catalogVerificationWork)
    .where(eq(catalogVerificationWork.leaseRunId, runId));

  const priorSummary = (run.summary ?? {}) as { snapshot?: SnapshotResult };
  const generatedAt = new Date();
  const summary: RunSummary = {
    runId,
    snapshot: priorSummary.snapshot ?? null,
    attempts,
    inFlight: inFlight.length,
    generatedAt: generatedAt.toISOString(),
  };

  await db
    .update(catalogVerificationRuns)
    .set({ summary: { ...priorSummary, ...summary }, updatedAt: generatedAt })
    .where(eq(catalogVerificationRuns.id, runId));

  return summary;
}

export interface WorkStatusSummary {
  runId: string;
  /** Distinct bottles this run has ever attempted, per the durable ledger. */
  touched: number;
  leased: number;
  verified: number;
  notEvidenced: number;
  /** Currently `retry_wait` — still eligible for another attempt. */
  retryable: number;
  /** Currently `failed_terminal` — retries exhausted. */
  rejected: number;
  cancelled: number;
  /** Count of ledger attempts (not distinct bottles) whose outcome was "error". */
  errors: number;
  generatedAt: string;
}

/**
 * Current-state tally for every bottle this run has ever touched, derived
 * from `catalog_verification_work.status` as of right now rather than the
 * (possibly stale) outcome recorded on an older ledger row — a bottle can be
 * re-leased and re-attempted after a "retry" outcome, so only the row's
 * current status says whether it's still retryable or has become durably
 * rejected/verified. Used for the --apply/--report/--resume checkpoint JSON,
 * which is why it's safe to call for a run that crashed mid-batch as well as
 * one that just finished.
 */
export async function summarizeRunWorkStatuses(db: DB, runId: string): Promise<WorkStatusSummary> {
  const attemptRows = await db
    .select({ bottleId: catalogVerificationAttempts.bottleId, outcome: catalogVerificationAttempts.outcome })
    .from(catalogVerificationAttempts)
    .where(eq(catalogVerificationAttempts.runId, runId));

  const bottleIds = [...new Set(attemptRows.map((r) => r.bottleId))];
  const errors = attemptRows.filter((r) => r.outcome === "error").length;

  const summary: WorkStatusSummary = {
    runId,
    touched: bottleIds.length,
    leased: 0,
    verified: 0,
    notEvidenced: 0,
    retryable: 0,
    rejected: 0,
    cancelled: 0,
    errors,
    generatedAt: new Date().toISOString(),
  };
  if (!bottleIds.length) return summary;

  const workRows = await db
    .select({ bottleId: catalogVerificationWork.bottleId, status: catalogVerificationWork.status })
    .from(catalogVerificationWork)
    .where(inArray(catalogVerificationWork.bottleId, bottleIds));

  for (const row of workRows) {
    if (row.status === "leased") summary.leased += 1;
    else if (row.status === "verified") summary.verified += 1;
    else if (row.status === "not_evidenced") summary.notEvidenced += 1;
    else if (row.status === "retry_wait") summary.retryable += 1;
    else if (row.status === "failed_terminal") summary.rejected += 1;
    else if (row.status === "cancelled") summary.cancelled += 1;
  }

  return summary;
}

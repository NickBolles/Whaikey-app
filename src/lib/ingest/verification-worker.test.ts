import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles, bottleVerifications, catalogVerificationWork } from "@/db/schema";
import { createTestBottle, setupTestDb } from "@/test/helpers";
import { claimWork, createVerificationRun, MAX_ATTEMPTS, snapshotRun } from "./verification-queue";
import {
  classifySoldItem,
  isValidSmokeProbeOutput,
  processClaimedBatch,
  reconcileClaudeResults,
  runSmokeProbe,
  runVerificationWorkers,
  summarizeWorkerOutcomes,
  type ClaudeStructuredRunner,
} from "./verification-worker";

async function createRun(db: DB, overrides: Partial<Parameters<typeof createVerificationRun>[1]> = {}) {
  return createVerificationRun(db, {
    mode: "apply",
    requestedModel: "sonnet",
    workers: 2,
    batchSize: 5,
    limit: 50,
    partitions: 1,
    ...overrides,
  });
}

const GOOD_EVIDENCE = {
  sold: true,
  evidenceUrl: "https://example-retailer.com/products/eagle-rare-10",
  evidenceLabel: "Example Retailer",
  evidenceKind: "retailer",
  retailerSku: "ER-10",
  upcs: ["080244002145"],
  abv: 45,
  ageYears: 10,
  price: 39.99,
  description: "A fine bourbon.",
};

const NOT_SOLD = { sold: false, evidenceUrl: null, evidenceLabel: null, evidenceKind: null, retailerSku: null, upcs: [], abv: null, ageYears: null, price: null, description: null };

function fakeRunner(handler: (prompt: string) => unknown): ClaudeStructuredRunner {
  return async ({ prompt }) => handler(prompt);
}

describe("verification worker: reconciliation (pure)", () => {
  it("reconciles every expected id exactly once, ignoring unrequested ids", () => {
    const results = [
      { id: "a", ...GOOD_EVIDENCE },
      { id: "unrequested", ...GOOD_EVIDENCE },
    ];
    const reconciled = reconcileClaudeResults(["a", "b"], results);
    expect(reconciled.get("a")).toEqual({ status: "ok", item: { id: "a", ...GOOD_EVIDENCE } });
    expect(reconciled.get("b")).toEqual({ status: "missing" });
    expect(reconciled.size).toBe(2);
  });

  it("flags duplicate ids instead of picking one silently", () => {
    const results = [
      { id: "a", ...NOT_SOLD },
      { id: "a", ...GOOD_EVIDENCE },
    ];
    const reconciled = reconcileClaudeResults(["a"], results);
    expect(reconciled.get("a")).toEqual({ status: "duplicate", count: 2 });
  });

  it("ignores items with a malformed (non-string / missing) id", () => {
    const results = [{ sold: true }, { id: 42, sold: true }];
    const reconciled = reconcileClaudeResults(["a"], results);
    expect(reconciled.get("a")).toEqual({ status: "missing" });
  });
});

describe("verification worker: classification (pure)", () => {
  it("classifies sold=false as not_evidenced", () => {
    expect(classifySoldItem({ id: "a", ...NOT_SOLD })).toEqual({ outcome: "not_evidenced" });
  });

  it("classifies sold=true with valid evidence as verified", () => {
    const result = classifySoldItem({ id: "a", ...GOOD_EVIDENCE });
    expect(result.outcome).toBe("verified");
  });

  it("classifies sold=true without valid evidence as retry", () => {
    expect(classifySoldItem({ id: "a", sold: true, evidenceUrl: "https://ttb.gov/cola", evidenceLabel: null, retailerSku: null, upcs: [], abv: null, ageYears: null, price: null, description: null })).toEqual({
      outcome: "retry",
      reason: "sold=true without valid non-TTB evidence",
    });
  });

  it("classifies a non-boolean sold field as retry", () => {
    expect(classifySoldItem({ id: "a", sold: "yes" })).toEqual({ outcome: "retry", reason: "malformed item: sold is not a boolean" });
  });
});

describe("verification worker: processClaimedBatch", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("persists good evidence, finalizes verified, and never mutates the bottle for sold=false", async () => {
    await createTestBottle(db, { id: "b1", name: "Eagle Rare 10 Year", status: "imported" });
    await createTestBottle(db, { id: "b2", name: "Weller Special Reserve", status: "imported" });
    const run = await createRun(db);
    await snapshotRun(db, run.id);
    const claimed = await claimWork(db, { runId: run.id, worker: "w", partition: 0, batchSize: 10 });
    expect(claimed).toHaveLength(2);

    const claudeRunner = fakeRunner(() => ({
      results: [
        { id: "b1", ...GOOD_EVIDENCE },
        { id: "b2", ...NOT_SOLD },
      ],
    }));

    const outcomes = await processClaimedBatch(db, claimed, { runId: run.id, worker: "w", partition: 0, model: "claude-sonnet-5", claudeRunner });
    expect(outcomes).toHaveLength(2);

    const verifiedOutcome = outcomes.find((o) => o.bottleId === "b1")!;
    expect(verifiedOutcome).toMatchObject({ outcome: "verified", finalized: true, status: "verified" });
    const [b1] = await db.select().from(bottles).where(eq(bottles.id, "b1"));
    expect(b1.status).toBe("verified");
    expect(b1.abv).toBe(45);
    const verifications = await db.select().from(bottleVerifications).where(eq(bottleVerifications.bottleId, "b1"));
    expect(verifications).toHaveLength(1);
    expect(verifications[0].url).toBe(GOOD_EVIDENCE.evidenceUrl);

    const notEvidencedOutcome = outcomes.find((o) => o.bottleId === "b2")!;
    expect(notEvidencedOutcome).toMatchObject({ outcome: "not_evidenced", finalized: true, status: "not_evidenced" });
    const [b2] = await db.select().from(bottles).where(eq(bottles.id, "b2"));
    expect(b2.status).toBe("imported"); // never mutated
  });

  it("treats a malformed top-level response as retryable for every claimed id, without mutating bottles", async () => {
    await createTestBottle(db, { id: "b1", status: "imported" });
    const run = await createRun(db);
    await snapshotRun(db, run.id);
    const claimed = await claimWork(db, { runId: run.id, worker: "w", partition: 0, batchSize: 10 });

    const claudeRunner = fakeRunner(() => ({ nonsense: true }));
    const outcomes = await processClaimedBatch(db, claimed, { runId: run.id, worker: "w", partition: 0, model: "claude-sonnet-5", claudeRunner });

    expect(outcomes).toEqual([expect.objectContaining({ bottleId: "b1", outcome: "retry", status: "retry_wait", finalized: true })]);
    const [b1] = await db.select().from(bottles).where(eq(bottles.id, "b1"));
    expect(b1.status).toBe("imported");
  });

  it("treats a missing expected id in the response as retryable", async () => {
    await createTestBottle(db, { id: "b1", status: "imported" });
    await createTestBottle(db, { id: "b2", status: "imported" });
    const run = await createRun(db);
    await snapshotRun(db, run.id);
    const claimed = await claimWork(db, { runId: run.id, worker: "w", partition: 0, batchSize: 10 });

    // Claude only answers for one of the two requested ids.
    const claudeRunner = fakeRunner(() => ({ results: [{ id: "b1", ...GOOD_EVIDENCE }] }));
    const outcomes = await processClaimedBatch(db, claimed, { runId: run.id, worker: "w", partition: 0, model: "claude-sonnet-5", claudeRunner });

    const missing = outcomes.find((o) => o.bottleId === "b2")!;
    expect(missing).toMatchObject({ outcome: "retry", status: "retry_wait", detail: "missing from Claude response" });
  });

  it("retries on a duplicate id in the response instead of picking one arbitrarily", async () => {
    await createTestBottle(db, { id: "b1", status: "imported" });
    const run = await createRun(db);
    await snapshotRun(db, run.id);
    const claimed = await claimWork(db, { runId: run.id, worker: "w", partition: 0, batchSize: 10 });

    const claudeRunner = fakeRunner(() => ({ results: [{ id: "b1", ...GOOD_EVIDENCE }, { id: "b1", ...NOT_SOLD }] }));
    const outcomes = await processClaimedBatch(db, claimed, { runId: run.id, worker: "w", partition: 0, model: "claude-sonnet-5", claudeRunner });

    expect(outcomes).toEqual([expect.objectContaining({ bottleId: "b1", outcome: "retry", status: "retry_wait" })]);
    const [b1] = await db.select().from(bottles).where(eq(bottles.id, "b1"));
    expect(b1.status).toBe("imported");
  });

  it("moves a Claude CLI (transient) failure to retry_wait, then failed_terminal after MAX_ATTEMPTS", async () => {
    await createTestBottle(db, { id: "b1", status: "imported" });
    const run = await createRun(db);
    await snapshotRun(db, run.id);

    const claudeRunner: ClaudeStructuredRunner = async () => {
      throw new Error("claude -p failed: timeout");
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const claimed = await claimWork(db, { runId: run.id, worker: "w", partition: 0, batchSize: 1 });
      expect(claimed).toHaveLength(1);
      const outcomes = await processClaimedBatch(db, claimed, { runId: run.id, worker: "w", partition: 0, model: "claude-sonnet-5", claudeRunner });
      expect(outcomes).toEqual([expect.objectContaining({ bottleId: "b1", outcome: "error", detail: "claude -p failed: timeout" })]);
      if (attempt < MAX_ATTEMPTS) {
        expect(outcomes[0].status).toBe("retry_wait");
        await db.update(catalogVerificationWork).set({ nextEligibleAt: new Date(0) }).where(eq(catalogVerificationWork.bottleId, "b1"));
      } else {
        expect(outcomes[0].status).toBe("failed_terminal");
      }
    }
  });

  it("no-ops when the lease token no longer matches the current holder (stale/reclaimed lease)", async () => {
    await createTestBottle(db, { id: "b1", status: "imported" });
    const run = await createRun(db);
    await snapshotRun(db, run.id);
    const [claimed] = await claimWork(db, { runId: run.id, worker: "w", partition: 0, batchSize: 1 });

    // Simulate another process reclaiming the row with a fresh lease token before our stale call finalizes.
    await db.update(catalogVerificationWork).set({ leaseToken: "someone-elses-token" }).where(eq(catalogVerificationWork.bottleId, "b1"));

    const claudeRunner = fakeRunner(() => ({ results: [{ id: "b1", ...GOOD_EVIDENCE }] }));
    const outcomes = await processClaimedBatch(db, [claimed], { runId: run.id, worker: "w", partition: 0, model: "claude-sonnet-5", claudeRunner });

    expect(outcomes).toEqual([expect.objectContaining({ bottleId: "b1", finalized: false })]);
    const [b1] = await db.select().from(bottles).where(eq(bottles.id, "b1"));
    expect(b1.status).toBe("imported"); // our stale write never landed
    const [row] = await db.select().from(catalogVerificationWork).where(eq(catalogVerificationWork.bottleId, "b1"));
    expect(row.leaseToken).toBe("someone-elses-token"); // untouched by our stale finalize
  });
});

describe("verification worker: runVerificationWorkers (bounded concurrency)", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("never claims more than leaseCap rows across concurrent workers, and processes exactly what it claims", async () => {
    for (let i = 1; i <= 5; i++) {
      await createTestBottle(db, { id: `b${i}`, status: "imported" });
    }
    const run = await createRun(db, { limit: 10, batchSize: 1 });
    await snapshotRun(db, run.id);

    const claudeRunner = fakeRunner((prompt) => {
      const requested = (JSON.parse(prompt.split("Candidates:\n")[1]) as Array<{ id: string }>).map((c) => c.id);
      return { results: requested.map((id) => ({ id, ...GOOD_EVIDENCE })) };
    });

    const result = await runVerificationWorkers(db, {
      runId: run.id,
      workers: 2,
      batchSize: 1,
      leaseCap: 3,
      model: "claude-sonnet-5",
      claudeRunner,
    });

    expect(result.leased).toBe(3);
    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes.every((o) => o.status === "verified")).toBe(true);

    const verifiedRows = await db.select().from(bottles).where(eq(bottles.status, "verified"));
    expect(verifiedRows).toHaveLength(3);
  });

  it("stops early once the queue is exhausted, even under leaseCap", async () => {
    await createTestBottle(db, { id: "b1", status: "imported" });
    const run = await createRun(db, { limit: 10, batchSize: 1 });
    await snapshotRun(db, run.id);

    const claudeRunner = fakeRunner(() => ({ results: [{ id: "b1", ...GOOD_EVIDENCE }] }));
    const result = await runVerificationWorkers(db, { runId: run.id, workers: 2, batchSize: 1, leaseCap: 10, model: "claude-sonnet-5", claudeRunner });

    expect(result.leased).toBe(1);
  });
});

describe("verification worker: report summary", () => {
  it("tallies verified/not_evidenced/retryable/rejected/errors from a batch of outcomes", () => {
    const outcomes = [
      { bottleId: "a", outcome: "verified" as const, finalized: true, status: "verified" as const },
      { bottleId: "b", outcome: "not_evidenced" as const, finalized: true, status: "not_evidenced" as const },
      { bottleId: "c", outcome: "retry" as const, finalized: true, status: "retry_wait" as const },
      { bottleId: "d", outcome: "error" as const, finalized: true, status: "failed_terminal" as const },
      { bottleId: "e", outcome: "error" as const, finalized: true, status: "retry_wait" as const },
    ];
    expect(summarizeWorkerOutcomes(outcomes)).toEqual({
      leased: 5,
      verified: 1,
      notEvidenced: 1,
      retryable: 2,
      rejected: 1,
      errors: 2,
    });
  });
});

describe("verification worker: preflight smoke probe", () => {
  it("succeeds on a well-formed pong response", async () => {
    const result = await runSmokeProbe(async () => ({ pong: true, model: "claude-sonnet-5" }), "claude-sonnet-5");
    expect(result).toEqual({ ok: true, model: "claude-sonnet-5", output: { pong: true, model: "claude-sonnet-5" } });
  });

  it("rejects a pong response from a model other than the pinned model", async () => {
    const result = await runSmokeProbe(async () => ({ pong: true, model: "claude-opus-4-8" }), "claude-sonnet-5");
    expect(result.ok).toBe(false);
    expect(isValidSmokeProbeOutput({ pong: true, model: "claude-opus-4-8" }, "claude-sonnet-5")).toBe(false);
  });

  it("fails when the runner throws (e.g. not logged in)", async () => {
    const result = await runSmokeProbe(async () => {
      throw new Error("not authenticated");
    }, "claude-sonnet-5");
    expect(result).toEqual({ ok: false, model: "claude-sonnet-5", error: "not authenticated" });
  });

  it("fails on a malformed probe response", () => {
    expect(isValidSmokeProbeOutput({ pong: false })).toBe(false);
    expect(isValidSmokeProbeOutput(null)).toBe(false);
    expect(isValidSmokeProbeOutput("pong")).toBe(false);
  });
});

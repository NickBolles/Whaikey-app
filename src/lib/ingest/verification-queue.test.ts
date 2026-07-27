import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles, bottleUpcs, catalogVerificationWork } from "@/db/schema";
import { createTestBottle, setupTestDb } from "@/test/helpers";
import {
  claimWork,
  computeCandidatePriority,
  createVerificationRun,
  finalizeWork,
  MAX_WORKERS,
  resolveModel,
  snapshotRun,
  summarizeRun,
} from "./verification-queue";

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

describe("verification queue: model pinning", () => {
  it("resolves known aliases to pinned model ids and passes through unknown ones", () => {
    expect(resolveModel("sonnet")).toBe("claude-sonnet-5");
    expect(resolveModel("Sonnet")).toBe("claude-sonnet-5");
    expect(resolveModel("claude-opus-4-8")).toBe("claude-opus-4-8");
  });
});

describe("verification queue: priority", () => {
  it("prioritizes checkable, fact-complete candidates over ambiguous ones", () => {
    const easy = computeCandidatePriority({
      name: "Eagle Rare 10 Year Bourbon",
      region: "Kentucky",
      abv: 45,
      ageYears: 10,
      upcs: [{ upc: "080244002145", source: "iowa" }],
    });
    const hard = computeCandidatePriority({
      name: "Unknown",
      region: null,
      abv: null,
      ageYears: null,
      upcs: [],
    });

    expect(easy.priority).toBeLessThan(hard.priority);
    expect(easy.reasonCodes).toEqual(expect.arrayContaining(["valid_upc", "iowa_upc", "facts_complete"]));
    expect(hard.reasonCodes).toEqual(expect.arrayContaining(["facts_incomplete", "name_ambiguous"]));
  });

  it("ignores invalid UPCs when scoring", () => {
    const { reasonCodes } = computeCandidatePriority({
      name: "Some Bourbon 12 Year",
      region: "Kentucky",
      abv: 45,
      ageYears: 12,
      upcs: [{ upc: "not-a-upc", source: "seed" }],
    });
    expect(reasonCodes).not.toContain("valid_upc");
  });

  it("allows the explicit ten-worker throughput-test cap and rejects larger pools", async () => {
    const db = await setupTestDb();
    await expect(createRun(db, { workers: MAX_WORKERS })).resolves.toMatchObject({ workers: MAX_WORKERS });
    await expect(createRun(db, { workers: MAX_WORKERS + 1 })).rejects.toThrow(/safety cap/);
  });
});

describe("verification queue: snapshot", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("is idempotent across repeated snapshots of the same imported bottles", async () => {
    await createTestBottle(db, { id: "b1", name: "Eagle Rare 10 Year", status: "imported" });
    await createTestBottle(db, { id: "b2", name: "Weller Special Reserve", status: "imported" });
    await db.insert(bottleUpcs).values({ id: "u1", bottleId: "b1", upc: "080244002145", source: "iowa", confirmedCount: 0 });

    const run = await createRun(db);
    const first = await snapshotRun(db, run.id);
    expect(first).toEqual({ scanned: 2, enqueued: 2, skippedExisting: 0 });

    const second = await snapshotRun(db, run.id);
    expect(second).toEqual({ scanned: 0, enqueued: 0, skippedExisting: 0 });

    const rows = await db.select().from(catalogVerificationWork);
    expect(rows).toHaveLength(2);

    const eagleRow = rows.find((r) => r.bottleId === "b1")!;
    expect(eagleRow.reasonCodes).toContain("valid_upc");
    expect(eagleRow.reasonCodes).toContain("iowa_upc");
  });

  it("advances past existing queue rows to enqueue the next imported slice", async () => {
    await createTestBottle(db, { id: "b1", status: "imported" });
    await createTestBottle(db, { id: "b2", status: "imported" });
    await createTestBottle(db, { id: "b3", status: "imported" });

    const firstRun = await createRun(db, { limit: 2 });
    expect(await snapshotRun(db, firstRun.id)).toEqual({ scanned: 2, enqueued: 2, skippedExisting: 0 });

    const secondRun = await createRun(db, { limit: 2 });
    expect(await snapshotRun(db, secondRun.id)).toEqual({ scanned: 1, enqueued: 1, skippedExisting: 0 });
    expect((await db.select().from(catalogVerificationWork)).map((row) => row.bottleId).sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("never enqueues verified or user_submitted bottles", async () => {
    await createTestBottle(db, { id: "b3", name: "Already Verified", status: "verified" });
    const run = await createRun(db);
    const result = await snapshotRun(db, run.id);
    expect(result).toEqual({ scanned: 0, enqueued: 0, skippedExisting: 0 });
  });
});

describe("verification queue: lease ownership + finalization", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
    await createTestBottle(db, { id: "b1", name: "Eagle Rare 10 Year", status: "imported" });
  });

  it("only finalizes when the lease token matches the current holder", async () => {
    const run = await createRun(db);
    await snapshotRun(db, run.id);
    const [claimed] = await claimWork(db, { runId: run.id, worker: "controller-p0", partition: 0, batchSize: 1 });
    expect(claimed.status).toBe("leased");
    expect(claimed.leaseWorker).toBe("controller-p0");

    const rejected = await finalizeWork(db, {
      bottleId: "b1",
      leaseToken: "wrong-token",
      runId: run.id,
      worker: "controller-p0",
      partition: 0,
      inputSnapshot: { name: "Eagle Rare 10 Year" },
      outcome: "verified",
    });
    expect(rejected.finalized).toBe(false);

    const stillLeased = await db.select().from(catalogVerificationWork).where(eq(catalogVerificationWork.bottleId, "b1"));
    expect(stillLeased[0].status).toBe("leased");

    const accepted = await finalizeWork(db, {
      bottleId: "b1",
      leaseToken: claimed.leaseToken!,
      runId: run.id,
      worker: "controller-p0",
      partition: 0,
      inputSnapshot: { name: "Eagle Rare 10 Year" },
      outcome: "verified",
      evidence: { evidenceUrl: "https://example-retailer.com/eagle-rare-10" },
    });
    expect(accepted).toEqual({ finalized: true, status: "verified" });

    const finalRow = (await db.select().from(catalogVerificationWork).where(eq(catalogVerificationWork.bottleId, "b1")))[0];
    expect(finalRow.status).toBe("verified");
    expect(finalRow.leaseToken).toBeNull();
    expect(finalRow.leaseRunId).toBeNull();
  });

  it("does not double-claim a row across two claim calls", async () => {
    const run = await createRun(db);
    await snapshotRun(db, run.id);
    const first = await claimWork(db, { runId: run.id, worker: "w1", partition: 0, batchSize: 5 });
    const second = await claimWork(db, { runId: run.id, worker: "w2", partition: 0, batchSize: 5 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("records a durable not_evidenced outcome without mutating the bottle, and stops selecting it", async () => {
    const run = await createRun(db);
    await snapshotRun(db, run.id);
    const [claimed] = await claimWork(db, { runId: run.id, worker: "controller-p0", partition: 0, batchSize: 1 });

    const result = await finalizeWork(db, {
      bottleId: "b1",
      leaseToken: claimed.leaseToken!,
      runId: run.id,
      worker: "controller-p0",
      partition: 0,
      inputSnapshot: { name: "Eagle Rare 10 Year" },
      outcome: "not_evidenced",
    });
    expect(result).toEqual({ finalized: true, status: "not_evidenced" });

    const [bottle] = await db.select().from(bottles).where(eq(bottles.id, "b1"));
    expect(bottle.status).toBe("imported");

    const workRow = (await db.select().from(catalogVerificationWork).where(eq(catalogVerificationWork.bottleId, "b1")))[0];
    expect(workRow.status).toBe("not_evidenced");

    // A fresh run's snapshot + claim must not resurface it.
    const secondRun = await createRun(db);
    const snapshot = await snapshotRun(db, secondRun.id);
    expect(snapshot.enqueued).toBe(0);
    const reclaimAttempt = await claimWork(db, { runId: secondRun.id, worker: "controller-p0", partition: 0, batchSize: 5 });
    expect(reclaimAttempt).toHaveLength(0);
  });

  it("moves retry outcomes to retry_wait until MAX_ATTEMPTS, then failed_terminal", async () => {
    const run = await createRun(db);
    await snapshotRun(db, run.id);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const [claimed] = await claimWork(db, { runId: run.id, worker: "w", partition: 0, batchSize: 1 });
      expect(claimed).toBeDefined();
      const result = await finalizeWork(db, {
        bottleId: "b1",
        leaseToken: claimed.leaseToken!,
        runId: run.id,
        worker: "w",
        partition: 0,
        inputSnapshot: {},
        outcome: "error",
        error: "timeout",
      });
      if (attempt < 3) {
        expect(result.status).toBe("retry_wait");
        // Force immediate re-eligibility so the next claim in this test can pick it up.
        await db.update(catalogVerificationWork).set({ nextEligibleAt: new Date(0) }).where(eq(catalogVerificationWork.bottleId, "b1"));
      } else {
        expect(result.status).toBe("failed_terminal");
      }
    }
  });
});

describe("verification queue: summary", () => {
  it("tallies attempts recorded under a run and reports in-flight leases", async () => {
    const db = await setupTestDb();
    await createTestBottle(db, { id: "b1", name: "Eagle Rare 10 Year", status: "imported" });
    await createTestBottle(db, { id: "b2", name: "Weller Special Reserve", status: "imported" });

    const run = await createRun(db, { limit: 10, batchSize: 10 });
    await snapshotRun(db, run.id);

    const claimed = await claimWork(db, { runId: run.id, worker: "w", partition: 0, batchSize: 10 });
    expect(claimed).toHaveLength(2);

    await finalizeWork(db, {
      bottleId: "b1",
      leaseToken: claimed.find((r) => r.bottleId === "b1")!.leaseToken!,
      runId: run.id,
      worker: "w",
      partition: 0,
      inputSnapshot: {},
      outcome: "verified",
    });

    const summary = await summarizeRun(db, run.id);
    expect(summary.snapshot).toEqual({ scanned: 2, enqueued: 2, skippedExisting: 0 });
    expect(summary.attempts).toEqual({ total: 1, verified: 1, notEvidenced: 0, retry: 0, error: 0 });
    // b2 is still leased (never finalized).
    expect(summary.inFlight).toBe(1);
  });
});

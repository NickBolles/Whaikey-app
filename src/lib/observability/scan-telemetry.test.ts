import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, setupTestDb } from "@/test/helpers";
import { confirmUpcMapping } from "@/lib/scan";
import { TELEMETRY_RETENTION_DAYS, sweepTelemetry } from "./metrics";
import { catalogCoverage, recordScanEvent, scanMetrics, type ScanEventInput } from "./scan-telemetry";

let db: DB;
beforeEach(async () => {
  db = await setupTestDb();
});

const DAY = 86_400_000;
/** Half-open windows: read with an `until` strictly after the inserts. */
const later = () => new Date(Date.now() + 60_000);

async function seed(events: Array<[ScanEventInput, number]>) {
  for (const [event, times] of events) {
    for (let i = 0; i < times; i++) await recordScanEvent(db, event);
  }
}

describe("recordScanEvent", () => {
  it("drops the barcode on a hit or a confirmation, keeps it on a gap", async () => {
    await recordScanEvent(db, { kind: "barcode", outcome: "matched", source: "own", upc: "080244002145" });
    await recordScanEvent(db, { kind: "barcode", outcome: "confirmed", source: "own", upc: "080244002145" });
    await recordScanEvent(db, { kind: "barcode", outcome: "miss", source: "none", upc: "080244002145" });
    await recordScanEvent(db, { kind: "label", outcome: "miss", source: "ai", upc: "080244002145" });
    const rows = await db.select().from(schema.scanEvents);
    expect(rows.map((r) => [r.outcome, r.kind, r.upc])).toEqual(
      expect.arrayContaining([
        ["matched", "barcode", null],
        ["confirmed", "barcode", null],
        ["miss", "barcode", "080244002145"],
        ["miss", "label", null],
      ]),
    );
  });
});

describe("scanMetrics", () => {
  it("computes hit, resolution and confirmation rates per kind", async () => {
    await seed([
      [{ kind: "barcode", outcome: "matched", source: "own", resultCount: 1, latencyMs: 40 }, 6],
      [{ kind: "barcode", outcome: "candidates", source: "upcitemdb", upc: "0001", resultCount: 3, latencyMs: 900 }, 2],
      [{ kind: "barcode", outcome: "miss", source: "none", upc: "0002", latencyMs: 1200 }, 2],
      [{ kind: "barcode", outcome: "confirmed", source: "own", confirmRank: 0 }, 5],
      [{ kind: "barcode", outcome: "confirmed", source: "none", confirmRank: null }, 1],
      [{ kind: "label", outcome: "candidates", source: "ai", resultCount: 2, latencyMs: 2500 }, 3],
      [{ kind: "label", outcome: "miss", source: "ai", latencyMs: 3000 }, 1],
      [{ kind: "label", outcome: "confirmed", source: "none" }, 2],
    ]);
    const m = await scanMetrics(db, { until: later() });

    expect(m.barcode).toMatchObject({ attempts: 10, matched: 6, candidates: 2, miss: 2, confirmed: 6 });
    expect(m.barcode.ownHitRate).toBeCloseTo(0.6);
    expect(m.barcode.resolutionRate).toBeCloseTo(0.8);
    expect(m.barcode.confirmationRate).toBeCloseTo(0.6);
    expect(m.barcode.confirmedTopMatchRate).toBeCloseTo(5 / 6);
    expect(m.barcode.confirmedOutsideOwnRate).toBeCloseTo(1 / 6);
    expect(m.barcode.latencyP50Ms).toBe(40);
    expect(m.barcode.latencyP95Ms).toBeGreaterThanOrEqual(900);

    expect(m.label).toMatchObject({ attempts: 4, candidates: 3, miss: 1, confirmed: 2, ownHitRate: null });
    expect(m.label.resolutionRate).toBeCloseTo(0.75);

    expect(m.topUnmappedUpcs).toEqual([
      { upc: "0001", scans: 2, misses: 0 },
      { upc: "0002", scans: 2, misses: 2 },
    ]);
    expect(m.barcode.bySource[0]).toEqual({ source: "own", outcome: "matched", count: 6 });
  });

  it("splits label scans by the path that answered: on-device OCR vs the AI read", async () => {
    await seed([
      [{ kind: "label", outcome: "candidates", source: "ocr", resultCount: 1, latencyMs: 80 }, 6],
      // Not-confident on-device reads: handed to the AI, counted once under it.
      [{ kind: "label", outcome: "deferred", source: "ocr", latencyMs: 90 }, 4],
      [{ kind: "label", outcome: "candidates", source: "ai", resultCount: 2, latencyMs: 2500 }, 3],
      [{ kind: "label", outcome: "miss", source: "ai", latencyMs: 3000 }, 1],
      [{ kind: "label", outcome: "confirmed", source: "ocr" }, 5],
    ]);
    const m = await scanMetrics(db, { until: later() });
    expect(m.label).toMatchObject({ attempts: 10, ocrResolved: 6, ocrDeferred: 4, aiCalls: 4, confirmed: 5 });
    expect(m.label.ocrResolvedRate).toBeCloseTo(0.6);
    expect(m.label.aiShare).toBeCloseTo(0.4);
    // Deferred reads are not answers anyone waited for: excluded from latency.
    expect(m.label.latencyP50Ms).toBe(80);
  });

  it("returns nulls rather than 0% when nothing was scanned", async () => {
    const m = await scanMetrics(db, { until: later() });
    expect(m.barcode).toMatchObject({ attempts: 0, ownHitRate: null, resolutionRate: null, latencyP50Ms: null });
    expect(m.topUnmappedUpcs).toEqual([]);
  });

  it("respects the window", async () => {
    await recordScanEvent(db, { kind: "barcode", outcome: "matched", source: "own" });
    const m = await scanMetrics(db, { since: later(), until: new Date(Date.now() + 120_000) });
    expect(m.barcode.attempts).toBe(0);
  });
});

describe("catalogCoverage", () => {
  it("counts scannable bottles with a barcode, a confirmed barcode and a flavor profile", async () => {
    const a = await createTestBottle(db, { name: "Eagle Rare 10 Year", flavorProfile: { sweet: 5 } });
    const b = await createTestBottle(db, { name: "Buffalo Trace", flavorProfile: null });
    await createTestBottle(db, { name: "Blanton's Original", flavorProfile: null });
    await createTestBottle(db, { name: "Pending Submission", status: "user_submitted" });
    await confirmUpcMapping(db, "080244002145", a.id);
    await db.insert(schema.bottleUpcs).values({ id: "seed-1", upc: "012345678905", bottleId: b.id, source: "iowa", confirmedCount: 0 });

    const c = await catalogCoverage(db);
    expect(c.bottles).toBe(3);
    expect(c.withUpc).toBe(2);
    expect(c.withConfirmedUpc).toBe(1);
    expect(c.withFlavorProfile).toBe(1);
    expect(c.upcRate).toBeCloseTo(2 / 3);
    expect(c.byStatus.user_submitted).toBe(1);
    expect(c.upcsBySource).toEqual(
      expect.arrayContaining([
        { source: "user", count: 1 },
        { source: "iowa", count: 1 },
      ]),
    );
  });
});

describe("retention", () => {
  it("sweeps scan events past the telemetry retention with the rest", async () => {
    await recordScanEvent(db, { kind: "barcode", outcome: "miss", source: "none", upc: "0002" });
    const swept = await sweepTelemetry(db, new Date(Date.now() + (TELEMETRY_RETENTION_DAYS + 1) * DAY));
    expect(swept.scanEvents).toBe(1);
    expect(await db.select().from(schema.scanEvents)).toHaveLength(0);
  });
});

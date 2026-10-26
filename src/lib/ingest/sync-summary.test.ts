import { describe, expect, it } from "vitest";
import {
  aggregateSyncSummaries,
  classifyReport,
  renderSyncSummaryMarkdown,
  summaryFromReport,
  type SourceRunSummary,
} from "./sync-summary";
import type { IngestReport } from "./types";

const report = (over: Partial<IngestReport> = {}): IngestReport => ({
  source: "oregon",
  scanned: 7493,
  candidates: 894,
  matchedExisting: 800,
  inserted: 94,
  upcsAdded: 0,
  dryRun: false,
  ...over,
});

const ok = (source: string, candidates: number, over: Partial<SourceRunSummary> = {}): SourceRunSummary => ({
  source,
  status: "ok",
  scanned: candidates * 2,
  candidates,
  matchedExisting: candidates,
  inserted: 0,
  upcsAdded: 0,
  catalogBefore: 100,
  catalogAfter: 100,
  ...over,
});

describe("classifyReport", () => {
  it("calls 0 candidates from a non-empty source 'empty' — the Oregon failure mode", () => {
    expect(classifyReport(report({ candidates: 0 }))).toBe("empty");
    expect(classifyReport(report({ candidates: 0 }), { allowEmpty: true })).toBe("ok");
    expect(classifyReport(report())).toBe("ok");
  });

  it("explains an empty result in the summary message", () => {
    const s = summaryFromReport(report({ candidates: 0 }), { catalogBefore: 1, catalogAfter: 1, durationMs: 5 });
    expect(s.status).toBe("empty");
    expect(s.message).toMatch(/scanned 7493 rows but produced 0 candidates/);
  });
});

describe("aggregateSyncSummaries", () => {
  it("is ok only when every source is ok or skipped", () => {
    const s = aggregateSyncSummaries([ok("iowa", 3031), { source: "vinmonopolet", status: "skipped", message: "no key" }]);
    expect(s.overall).toBe("ok");
    expect(s.problems).toEqual([]);
  });

  it("is degraded, not failed, when a third party is unavailable", () => {
    const s = aggregateSyncSummaries([
      ok("iowa", 3031),
      { source: "vinmonopolet", status: "degraded", message: "returned HTML (STRATO - Domain not available)" },
    ]);
    expect(s.overall).toBe("degraded");
    expect(s.problems).toEqual(["vinmonopolet: degraded — returned HTML (STRATO - Domain not available)"]);
  });

  it("fails on an empty or failed source, and on an expected source that wrote nothing", () => {
    expect(aggregateSyncSummaries([ok("iowa", 1), { source: "oregon", status: "empty" }]).overall).toBe("failed");
    const missing = aggregateSyncSummaries([ok("iowa", 1)], [], { expected: ["iowa", "bc"] });
    expect(missing.overall).toBe("failed");
    expect(missing.rows.find((r) => r.source === "bc")?.status).toBe("failed");
  });

  it("computes per-source deltas against the previous run and warns on a halving", () => {
    const s = aggregateSyncSummaries([ok("iowa", 3031), ok("utah", 100)], [ok("iowa", 3000), ok("utah", 340)]);
    expect(s.rows.find((r) => r.source === "iowa")).toMatchObject({ previousCandidates: 3000, candidateDelta: 31 });
    expect(s.rows.find((r) => r.source === "utah")?.candidateDelta).toBe(-240);
    expect(s.warnings).toEqual(["utah: candidates fell 340 → 100 since the last run"]);
    expect(s.overall).toBe("ok");
  });

  it("totals the run and spans the catalog before/after across sources", () => {
    const s = aggregateSyncSummaries([
      ok("bc", 757, { inserted: 7, upcsAdded: 4, catalogBefore: 33204, catalogAfter: 33211 }),
      ok("cola", 93, { inserted: 57, catalogBefore: 33228, catalogAfter: 33285 }),
    ]);
    expect(s.catalogBefore).toBe(33204);
    expect(s.catalogAfter).toBe(33285);
    expect(s.totals).toMatchObject({ candidates: 850, inserted: 64, upcsAdded: 4 });
  });
});

describe("renderSyncSummaryMarkdown", () => {
  it("renders a table row per source with status, delta and escaped notes", () => {
    const md = renderSyncSummaryMarkdown(
      aggregateSyncSummaries(
        [ok("iowa", 3031), { source: "vinmonopolet", status: "degraded", message: "a | b" }],
        [ok("iowa", 3000)],
      ),
      { runUrl: "https://example.test/run/1" },
    );
    expect(md).toContain("## ⚠️ Catalog sync degraded");
    expect(md).toMatch(/\| iowa \| ✅ ok \| 6,062 \| 3,031 \| \+31 \|/);
    expect(md).toContain("a \\| b");
    expect(md).toContain("Run: https://example.test/run/1");
  });
});

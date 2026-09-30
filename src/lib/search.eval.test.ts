import { beforeAll, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { seedDatabase } from "@/db/seed";
import { setupTestDb } from "@/test/helpers";
import {
  RECALL_K,
  SEARCH_EVAL_MIN_RECALL,
  SEARCH_EVAL_QUERIES,
  evaluateSearch,
  type SearchEvalReport,
} from "@/lib/search.eval";

/**
 * The committed search evaluation (PLAN.md §10, review WP-22), run as part of
 * `pnpm test` against the real seed catalog so a ranking or matching change
 * that costs recall fails CI rather than a user.
 */
let db: DB;
let report: SearchEvalReport;

beforeAll(async () => {
  db = await setupTestDb();
  await seedDatabase(db);
  report = await evaluateSearch(db);
});

function describeMisses(r: SearchEvalReport): string {
  return r.results
    .filter((x) => x.recall < 1)
    .map((x) => `  ${x.recall.toFixed(2)} ${JSON.stringify(x.query)} → [${x.top.join(", ")}]`)
    .join("\n");
}

describe("search evaluation set", () => {
  it("is the fifty queries PLAN.md §10 commits to, each answerable from the seed catalog", async () => {
    expect(SEARCH_EVAL_QUERIES).toHaveLength(50);
    expect(new Set(SEARCH_EVAL_QUERIES.map((q) => q.query)).size).toBe(50);
    const ids = new Set(
      (await db.query.bottles.findMany({ columns: { id: true } })).map((b) => b.id),
    );
    // A typo in an expected id would make a query unwinnable and quietly cap
    // the score, which reads as a search regression rather than a data bug.
    for (const q of SEARCH_EVAL_QUERIES) {
      expect(q.relevant.length, q.query).toBeGreaterThan(0);
      for (const id of q.relevant) expect(ids.has(id), `${q.query}: ${id}`).toBe(true);
    }
  });

  it("covers misspellings, slang, distillery-only, age statements and punctuation", () => {
    const kinds = new Set(SEARCH_EVAL_QUERIES.map((q) => q.kind));
    for (const kind of ["misspelling", "slang", "distillery", "age", "punctuation", "exact"]) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }
    expect(SEARCH_EVAL_QUERIES.filter((q) => q.kind === "misspelling").length).toBeGreaterThanOrEqual(15);
  });

  it(`keeps Recall@${RECALL_K} at or above ${SEARCH_EVAL_MIN_RECALL}`, () => {
    expect(report.recallAt5, `misses:\n${describeMisses(report)}`).toBeGreaterThanOrEqual(SEARCH_EVAL_MIN_RECALL);
  });

  it("never misses an exact name — those are controls, not tuning", () => {
    const controls = report.results.filter((r) => r.kind === "exact");
    expect(controls.every((r) => r.firstHit === 1), describeMisses(report)).toBe(true);
  });
});

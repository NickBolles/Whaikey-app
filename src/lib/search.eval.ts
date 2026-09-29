/**
 * Catalog search evaluation set (PLAN.md §10 "Search quality", review WP-22).
 *
 * Fifty queries the way people actually type them — misspelled, abbreviated,
 * distillery-only, with the age statement written three different ways — each
 * with the seed-catalog bottles a person typing it would accept. Scored as
 * Recall@5: of the bottles that answer the query (at most five of them), how
 * many are in the first five results. A query with one right answer therefore
 * scores 1 or 0; "nikka" scores the share of the top five that are Nikka.
 *
 * `src/lib/search.eval.test.ts` runs this in `pnpm test` against the seed
 * catalog and fails under `SEARCH_EVAL_MIN_RECALL`. To see every query:
 *
 *   pnpm tsx src/lib/search.eval.ts
 *
 * Rules for editing the set, since a set tuned until it passes measures
 * nothing:
 * - Queries are written from how the bottle is asked for, before checking
 *   whether search finds it. Do not delete or soften a query because it fails;
 *   a failing query is the set doing its job — lower the recorded score or fix
 *   search.
 * - Expected ids are bottles a person would accept, not whatever search
 *   currently returns.
 * - Keep the mix: roughly a third misspellings, the rest slang/aliases,
 *   distillery-only, age statements, punctuation and exact names as controls.
 */
import type { DB } from "@/db";
import { searchBottles } from "@/lib/search";

export type SearchEvalKind =
  | "exact"
  | "misspelling"
  | "slang"
  | "distillery"
  | "age"
  | "punctuation";

export interface SearchEvalQuery {
  query: string;
  kind: SearchEvalKind;
  /** Seed bottle ids (src/db/seed/data.ts) that correctly answer the query. */
  relevant: string[];
}

const LAPHROAIG = ["laphroaig-10", "laphroaig-quarter-cask", "laphroaig-lore"];
const LAGAVULIN = ["lagavulin-8", "lagavulin-16", "lagavulin-distillers-edition"];
const GLENMORANGIE = ["glenmorangie-10", "glenmorangie-lasanta", "glenmorangie-signet"];
const HIBIKI = ["hibiki-harmony", "hibiki-21"];
const JACK_DANIELS = ["jack-daniels-old-no-7", "jack-daniels-sbbp", "jack-daniels-bonded"];
const MACALLAN_12 = ["macallan-12-sherry", "macallan-12-double-cask"];
const HEAVEN_HILL = [
  "elijah-craig-small-batch", "elijah-craig-barrel-proof", "henry-mckenna-10", "larceny-small-batch",
  "larceny-barrel-proof", "evan-williams-black", "evan-williams-bib", "heaven-hill-bib-7",
  "evan-williams-single-barrel", "old-fitzgerald-bib", "rittenhouse-bib", "pikesville-6",
  "elijah-craig-rye", "mellow-corn", "bernheim-original",
];
const NIKKA = [
  "yoichi-single-malt", "miyagikyo-single-malt", "nikka-from-the-barrel", "nikka-coffey-grain",
  "taketsuru-pure-malt", "nikka-days",
];
const SUNTORY = [
  "yamazaki-12", "yamazaki-18", "hakushu-12", "hakushu-18", "hibiki-harmony", "hibiki-21", "suntory-toki",
];
const MIDLETON = [
  "jameson", "jameson-black-barrel", "redbreast-12", "redbreast-12-cask-strength", "redbreast-15",
  "redbreast-lustau", "green-spot", "yellow-spot-12", "powers-gold-label", "powers-johns-lane-12",
  "midleton-very-rare", "jameson-caskmates-stout",
];
const KILBEGGAN = ["tyrconnell", "connemara-peated", "kilbeggan-traditional"];
const WILLIAM_GRANT = ["monkey-shoulder", "grants-triple-wood"];
const SPRINGBANK = ["springbank-10", "springbank-15", "longrow-peated"];

export const SEARCH_EVAL_QUERIES: SearchEvalQuery[] = [
  // Exact names — controls. A regression here is not a tuning question.
  { query: "eagle rare 10", kind: "exact", relevant: ["eagle-rare-10"] },
  { query: "lagavulin 16", kind: "exact", relevant: ["lagavulin-16"] },
  { query: "redbreast 12", kind: "exact", relevant: ["redbreast-12", "redbreast-12-cask-strength"] },
  { query: "caol ila 12", kind: "exact", relevant: ["caol-ila-12"] },

  // Misspellings — FEATURES.md §2.1 names the first one.
  { query: "lafroig", kind: "misspelling", relevant: LAPHROAIG },
  { query: "laphroig 10", kind: "misspelling", relevant: ["laphroaig-10"] },
  { query: "glenfidich 12", kind: "misspelling", relevant: ["glenfiddich-12"] },
  { query: "macallen 12", kind: "misspelling", relevant: MACALLAN_12 },
  { query: "lagavulen", kind: "misspelling", relevant: LAGAVULIN },
  { query: "ardbeg uigedail", kind: "misspelling", relevant: ["ardbeg-uigeadail"] },
  { query: "bunnahabain", kind: "misspelling", relevant: ["bunnahabhain-12"] },
  { query: "bruichladich", kind: "misspelling", relevant: ["bruichladdich-classic-laddie"] },
  { query: "glenmorangy", kind: "misspelling", relevant: GLENMORANGIE },
  { query: "balveny doublewood", kind: "misspelling", relevant: ["balvenie-12-doublewood"] },
  { query: "yamazakki 12", kind: "misspelling", relevant: ["yamazaki-12"] },
  { query: "hibicki", kind: "misspelling", relevant: HIBIKI },
  { query: "johnny walker blue", kind: "misspelling", relevant: ["johnnie-walker-blue"] },
  { query: "wild turky 101", kind: "misspelling", relevant: ["wild-turkey-101", "wild-turkey-101-rye"] },
  { query: "knob creak 9", kind: "misspelling", relevant: ["knob-creek-9"] },
  { query: "talsker 10", kind: "misspelling", relevant: ["talisker-10"] },
  { query: "old forrester 1920", kind: "misspelling", relevant: ["old-forester-1920"] },
  { query: "weller antiqe", kind: "misspelling", relevant: ["weller-antique-107"] },
  { query: "four rosses single barrel", kind: "misspelling", relevant: ["four-roses-single-barrel"] },
  { query: "tulamore dew", kind: "misspelling", relevant: ["tullamore-dew"] },
  { query: "kaol ila", kind: "misspelling", relevant: ["caol-ila-12"] },

  // Slang and aliases — FEATURES.md §2.1's "weller sr" and "ECBP" included.
  { query: "weller sr", kind: "slang", relevant: ["weller-special-reserve"] },
  { query: "ecbp", kind: "slang", relevant: ["elijah-craig-barrel-proof"] },
  { query: "wlw", kind: "slang", relevant: ["william-larue-weller"] },
  { query: "frog 10", kind: "slang", relevant: ["laphroaig-10"] },
  { query: "oogie", kind: "slang", relevant: ["ardbeg-uigeadail"] },
  { query: "baby saz", kind: "slang", relevant: ["sazerac-rye"] },
  { query: "jamo", kind: "slang", relevant: ["jameson"] },
  { query: "old fitz", kind: "slang", relevant: ["old-fitzgerald-bib"] },
  { query: "mvr", kind: "slang", relevant: ["midleton-very-rare"] },
  { query: "jd", kind: "slang", relevant: JACK_DANIELS },

  // Distillery only — the answer is the distillery's range.
  { query: "heaven hill", kind: "distillery", relevant: HEAVEN_HILL },
  { query: "nikka", kind: "distillery", relevant: NIKKA },
  { query: "suntory", kind: "distillery", relevant: SUNTORY },
  { query: "midleton", kind: "distillery", relevant: MIDLETON },
  { query: "kilbeggan", kind: "distillery", relevant: KILBEGGAN },
  { query: "william grant", kind: "distillery", relevant: WILLIAM_GRANT },
  { query: "springbank", kind: "distillery", relevant: SPRINGBANK },

  // Age statements, written the ways people write them.
  { query: "talisker 10 year", kind: "age", relevant: ["talisker-10"] },
  { query: "macallan 12 year old", kind: "age", relevant: MACALLAN_12 },
  { query: "lagavulin 16yr", kind: "age", relevant: ["lagavulin-16"] },
  { query: "glenlivet 18 yo", kind: "age", relevant: ["glenlivet-18"] },

  // Punctuation the catalog has and the query does not.
  { query: "makers mark 46", kind: "punctuation", relevant: ["makers-mark-46"] },
  { query: "jack daniels", kind: "punctuation", relevant: JACK_DANIELS },
  { query: "blantons", kind: "punctuation", relevant: ["blantons-original"] },
  { query: "old granddad 114", kind: "punctuation", relevant: ["old-grand-dad-114"] },
];

/**
 * The floor `pnpm test` enforces. Recorded when the set was committed (WP-22):
 * 1.000 with the trigram fallback, against 0.760 for the substring search it
 * replaced. One query is 0.02 of the mean, so this allows exactly one miss —
 * room for a deliberate trade to land with its reason written down, not for
 * drift. Raise it when search improves; never lower it to make a change pass.
 */
export const SEARCH_EVAL_MIN_RECALL = 0.98;

export const RECALL_K = 5;

export interface SearchEvalResult {
  query: string;
  kind: SearchEvalKind;
  recall: number;
  /** 1-based rank of the first relevant result, null when none is in the top K. */
  firstHit: number | null;
  top: string[];
}

export interface SearchEvalReport {
  recallAt5: number;
  /** Share of queries with at least one relevant result in the top K. */
  hitRate: number;
  byKind: Record<SearchEvalKind, number>;
  results: SearchEvalResult[];
}

export async function evaluateSearch(
  db: DB,
  queries: SearchEvalQuery[] = SEARCH_EVAL_QUERIES,
): Promise<SearchEvalReport> {
  const results: SearchEvalResult[] = [];
  for (const q of queries) {
    const top = (await searchBottles(db, q.query, { limit: RECALL_K })).map((r) => r.id);
    const relevant = new Set(q.relevant);
    const hits = top.filter((id) => relevant.has(id)).length;
    const firstIndex = top.findIndex((id) => relevant.has(id));
    results.push({
      query: q.query,
      kind: q.kind,
      recall: hits / Math.min(relevant.size, RECALL_K),
      firstHit: firstIndex >= 0 ? firstIndex + 1 : null,
      top,
    });
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const kinds = [...new Set(results.map((r) => r.kind))];
  return {
    recallAt5: mean(results.map((r) => r.recall)),
    hitRate: mean(results.map((r) => (r.firstHit ? 1 : 0))),
    byKind: Object.fromEntries(
      kinds.map((k) => [k, mean(results.filter((r) => r.kind === k).map((r) => r.recall))]),
    ) as Record<SearchEvalKind, number>,
    results,
  };
}

// `pnpm tsx src/lib/search.eval.ts` — the full per-query report against a
// fresh in-memory seed catalog, for tuning and for PR descriptions. Set
// SEARCH_EVAL_DATABASE_URL to an EMPTY Postgres database to score the same set
// on real Postgres (it is migrated and seeded; the pg_trgm code paths are the
// same, which is the thing worth confirming).
if (process.argv[1]?.endsWith("search.eval.ts")) {
  (async () => {
    const { createDb } = await import("@/db");
    const { migrateDb } = await import("@/db/migrate");
    const { seedDatabase } = await import("@/db/seed");
    const url = process.env.SEARCH_EVAL_DATABASE_URL ?? ":memory:";
    const db = createDb(url);
    await migrateDb(db, url);
    await seedDatabase(db);
    const report = await evaluateSearch(db);
    for (const r of report.results) {
      const mark = r.recall === 1 ? "ok  " : r.recall > 0 ? "part" : "MISS";
      console.log(`${mark} ${r.recall.toFixed(2)}  ${r.kind.padEnd(11)} ${JSON.stringify(r.query).padEnd(30)} → ${r.top.join(", ")}`);
    }
    console.log(`\nRecall@${RECALL_K} ${report.recallAt5.toFixed(3)} · hit rate ${report.hitRate.toFixed(3)} · ${report.results.length} queries`);
    for (const [kind, recall] of Object.entries(report.byKind)) console.log(`  ${kind.padEnd(11)} ${recall.toFixed(3)}`);
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

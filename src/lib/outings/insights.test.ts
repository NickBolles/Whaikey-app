import { describe, expect, it } from "vitest";
import { buildInsights, buildRecognitions, jaccard, pairSimilarity, pearson, type InsightTasting } from "./insights";

const people = [
  { participantId: "a", name: "Ana" },
  { participantId: "b", name: "Ben" },
  { participantId: "c", name: "Cam" },
];
let clock = 0;
const t = (participantId: string, key: string, rating: number | null, tags: string[] = [], note: string | null = null, at = ++clock): InsightTasting => ({
  participantId,
  key,
  label: key.replace(/^l:/, ""),
  rating,
  tags,
  note,
  at,
});

describe("similarity math", () => {
  it("pearson and jaccard on fixtures", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
    expect(pearson([3, 3], [1, 5])).toBeNull();
    expect(jaccard(["pear", "smoke"], ["smoke"])).toBeCloseTo(0.5);
    expect(jaccard([], [])).toBeNull();
  });
  it("needs two shared rated bottles", () => {
    expect(pairSimilarity([t("a", "l:x", 4)], [t("b", "l:x", 4)])).toBeNull();
    expect(pairSimilarity([t("a", "l:x", 4), t("a", "l:y", null)], [t("b", "l:x", 4), t("b", "l:y", 3)])).toBeNull();
  });
  it("scores identical palates above opposite ones", () => {
    const same = pairSimilarity([t("a", "l:x", 5, ["smoke"]), t("a", "l:y", 2, ["pear"]), t("a", "l:z", 3)], [t("b", "l:x", 5, ["smoke"]), t("b", "l:y", 2, ["pear"]), t("b", "l:z", 3)])!;
    const opposite = pairSimilarity([t("a", "l:x", 5, ["smoke"]), t("a", "l:y", 1), t("a", "l:z", 3)], [t("c", "l:x", 1, ["pear"]), t("c", "l:y", 5), t("c", "l:z", 3)])!;
    expect(same.score).toBeCloseTo(1);
    expect(same.meanGap).toBe(0);
    expect(same.commonTags).toEqual(["pear", "smoke"]);
    expect(opposite.score).toBeLessThan(0.3);
  });
});

describe("buildInsights", () => {
  it("says plainly that it is waiting for data", () => {
    const i = buildInsights([t("a", "l:x", 4)], people, "a");
    expect(i.waiting).toMatch(/two people have rated at least 2 of the same bottles/);
    expect(i.twins).toBeNull();
    expect(i.closest).toBeNull();
  });
  it("finds palate twins, the viewer's closest, favourite, divisive and called it", () => {
    clock = 0;
    const rows = [
      t("a", "l:Lagavulin 16", 5, ["smoke", "pear"]),
      t("b", "l:Lagavulin 16", 5, ["smoke"]),
      t("c", "l:Lagavulin 16", 4, ["smoke", "pear"]),
      t("a", "l:Ardbeg 10", 2, ["peat-smoke"]),
      t("b", "l:Ardbeg 10", 2, ["peat-smoke"]),
      t("c", "l:Ardbeg 10", 5, ["vanilla"]),
    ];
    const i = buildInsights(rows, people, "c");
    expect(i.waiting).toBeNull();
    expect([i.twins!.aName, i.twins!.bName].sort()).toEqual(["Ana", "Ben"]);
    expect(i.twins!.why).toMatch(/Across 2 bottles you both rated, you gave the same stars/);
    expect(i.closest).not.toBeNull();
    expect(i.favourite!.label).toBe("Lagavulin 16");
    expect(i.divisive!.label).toBe("Ardbeg 10");
    expect(i.divisive!.why).toBe("Ratings ran from 2 to 5 stars.");
    expect(i.calledIt!.name).toBe("Ana");
    expect(i.learnFrom!.name).toBe("Ana");
    expect(i.agreed.find((b) => b.label === "Lagavulin 16")!.tags.length).toBeGreaterThan(0);
  });
  it("ignores people the viewer can't see (blocked, suspended, expired)", () => {
    clock = 0;
    const rows = [t("a", "l:x", 5), t("a", "l:y", 1), t("z", "l:x", 5), t("z", "l:y", 1)];
    const i = buildInsights(rows, people, "a");
    expect(i.twins).toBeNull();
    expect(JSON.stringify(i)).not.toContain('"z"');
  });
  it("no divisive bottle when spread is small", () => {
    const i = buildInsights([t("a", "l:x", 4), t("b", "l:x", 3)], people, null);
    expect(i.divisive).toBeNull();
  });
});

describe("buildRecognitions", () => {
  const rows = () => {
    clock = 0;
    return [
      t("a", "l:Lagavulin 16", 5, ["smoke", "pear", "honey", "vanilla"], "Smoke up front, pear on the finish"),
      t("b", "l:Lagavulin 16", 5, ["smoke"]),
      t("c", "l:Lagavulin 16", 4, ["smoke"]),
      t("a", "l:Ardbeg 10", 2, ["peat-smoke"]),
      t("b", "l:Ardbeg 10", 2, ["peat-smoke"]),
    ];
  };
  it("earns tasting recognitions, at most one winner each", () => {
    const r = buildRecognitions(buildInsights(rows(), people, null), rows(), people, [{ participantId: "a", label: "Lagavulin 16", count: 2 }]);
    const ids = r.map((x) => x.id);
    expect(ids).toContain("palate_twins");
    expect(ids).toContain("best_note");
    expect(ids).toContain("explorer");
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("never references volume, pours, streaks or drinking", () => {
    const r = buildRecognitions(buildInsights(rows(), people, null), rows(), people, [{ participantId: "a", label: "Lagavulin 16", count: 2 }]);
    const ins = buildInsights(rows(), people, "a");
    const text = JSON.stringify([r, ins]);
    expect(text).not.toMatch(/pour|\bml\b|\boz\b|dram|drink|glass|streak|most bottles|sip|shot/i);
  });
  it("no best note on a tie", () => {
    const r = buildRecognitions(buildInsights(rows(), people, null), rows(), people, [
      { participantId: "a", label: "x", count: 1 },
      { participantId: "b", label: "y", count: 1 },
    ]);
    expect(r.map((x) => x.id)).not.toContain("best_note");
  });
});


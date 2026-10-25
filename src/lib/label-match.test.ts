import { describe, expect, it } from "vitest";
import {
  LABEL_MATCH_THRESHOLD,
  editDistance,
  labelQueries,
  normalizeLabelLine,
  parseLabelText,
  rankCandidates,
  scoreCandidate,
  tokenPresence,
} from "./label-match";
import { AMBIGUOUS_READS, FIXTURE_CATALOG, LABEL_FIXTURES } from "./label-match.fixtures";

const byId = (id: string) => FIXTURE_CATALOG.find((c) => c.id === id)!;

describe("normalizeLabelLine", () => {
  it("folds case, diacritics, apostrophes and decimal commas", () => {
    expect(normalizeLabelLine("Maker’s Mark  43,5 % Vol.")).toBe("makers mark 43.5 % vol.");
    expect(normalizeLabelLine("Añejo")).toBe("anejo");
  });

  it("repairs digit confusions only next to digits", () => {
    expect(normalizeLabelLine("l2 YEARS")).toBe("12 years");
    expect(normalizeLabelLine("4O% VOL")).toBe("40% vol");
    expect(normalizeLabelLine("LAGAVULIN")).toBe("lagavulin");
  });
});

describe("parseLabelText", () => {
  it("extracts age statements in the forms labels print them", () => {
    expect(parseLabelText("12\nYEAR OLD").ageYears).toBe(12);
    expect(parseLabelText("AGED 16 YEARS").ageYears).toBe(16);
    expect(parseLabelText("10yo").ageYears).toBe(10);
    expect(parseLabelText("18 ans d'âge").ageYears).toBe(18);
    expect(parseLabelText("NO AGE HERE").ageYears).toBeNull();
  });

  it("reads ABV from %, alc/vol, or proof", () => {
    expect(parseLabelText("43% vol").abv).toBe(43);
    expect(parseLabelText("ALC 46.3 BY VOL").abv).toBe(46.3);
    expect(parseLabelText("101 PROOF").abv).toBe(50.5);
    // 750ml is a size, not a strength.
    expect(parseLabelText("750 ML").abv).toBeNull();
  });

  it("keeps vintages but not founding years", () => {
    expect(parseLabelText("EST. 1816").vintage).toBeNull();
    expect(parseLabelText("DISTILLED 2009").vintage).toBe(2009);
  });

  it("drops boilerplate and numbers from the word tokens", () => {
    const s = parseLabelText("GOVERNMENT WARNING\nBUFFALO TRACE\n750 ML");
    expect(s.tokens).toContain("buffalo");
    expect(s.tokens).not.toContain("government");
    expect(s.tokens).not.toContain("750");
  });

  it("ranks tokens by printed size when the engine reports heights", () => {
    const s = parseLabelText([
      { text: "distilled by heaven hill", height: 0.02 },
      { text: "ELIJAH CRAIG", height: 0.12 },
    ]);
    expect(s.tokens.slice(0, 2)).toEqual(["elijah", "craig"]);
    expect(s.weights.elijah).toBeGreaterThan(s.weights.heaven);
  });

  it("surfaces cask words", () => {
    expect(parseLabelText("SHERRY OAK CASK").caskWords).toContain("sherry");
    expect(parseLabelText("BARREL PROOF").caskWords).toContain("barrel proof");
  });
});

describe("token matching", () => {
  it("edit distance", () => {
    expect(editDistance("glenfiddich", "glenfiddlch")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
  });

  it("forgives OCR typos on long tokens but not on short ones", () => {
    const s = parseLabelText("GLENFIDDLCH care");
    expect(tokenPresence("glenfiddich", s)).toBeGreaterThan(0.85);
    expect(tokenPresence("rare", s)).toBe(0);
  });

  it("finds a word split across lines", () => {
    expect(tokenPresence("talisker", parseLabelText("TALIS\nKER"))).toBeGreaterThanOrEqual(0.85);
  });
});

describe("scoreCandidate", () => {
  it("a contradicting age is near-disqualifying", () => {
    const s = parseLabelText("GLENFIDDICH\n18 YEARS OLD");
    expect(scoreCandidate(s, byId("glenfiddich-18"))).toBeGreaterThan(scoreCandidate(s, byId("glenfiddich-12")) + 0.4);
  });

  it("a number in the name must be on the label", () => {
    const s = parseLabelText("WILD TURKEY\n81 PROOF");
    expect(scoreCandidate(s, byId("wild-turkey-81"))).toBeGreaterThan(scoreCandidate(s, byId("wild-turkey-101")));
  });

  it("generic-only names score low", () => {
    const s = parseLabelText("KENTUCKY STRAIGHT BOURBON");
    expect(scoreCandidate(s, { ...byId("buffalo-trace"), name: "Kentucky Straight Bourbon" })).toBeLessThanOrEqual(0.3);
  });
});

describe("fixture set (seed of the A4 eval)", () => {
  const results = LABEL_FIXTURES.map((f) => ({ f, r: rankCandidates(parseLabelText(f.ocr), FIXTURE_CATALOG) }));

  it.each(results.map(({ f, r }) => [f.name, f, r] as const))("%s → top-1", (_n, f, r) => {
    expect(r.candidates[0]?.id).toBe(f.expected);
  });

  it.each(results.filter(({ f }) => f.confident).map(({ f, r }) => [f.name, r] as const))(
    "%s is confident enough to skip the AI read",
    (_n, r) => {
      expect(r.confidence).toBeGreaterThanOrEqual(LABEL_MATCH_THRESHOLD);
      expect(r.confident).toBe(true);
    },
  );

  it("hit@1 floor ≥ 90% and hit@3 = 100% on the fixture set", () => {
    const hit1 = results.filter(({ f, r }) => r.candidates[0]?.id === f.expected).length / results.length;
    const hit3 = results.filter(({ f, r }) => r.candidates.some((c) => c.id === f.expected)).length / results.length;
    expect(hit1).toBeGreaterThanOrEqual(0.9);
    expect(hit3).toBe(1);
  });

  it.each(AMBIGUOUS_READS.map((a) => [a.name, a.ocr] as const))("%s defers to the AI read", (_n, ocr) => {
    const r = rankCandidates(parseLabelText(ocr), FIXTURE_CATALOG);
    expect(r.confident).toBe(false);
  });
});

describe("labelQueries", () => {
  it("is bounded and built from distinctive words", () => {
    const q = labelQueries(parseLabelText("THE\nMACALLAN\nSHERRY OAK CASK\n12 YEARS OLD\nHIGHLAND SINGLE MALT"));
    expect(q.length).toBeGreaterThan(0);
    expect(q.length).toBeLessThanOrEqual(6);
    expect(q[0]).toContain("macallan");
    expect(q.join(" ")).not.toMatch(/\bsingle\b|\bmalt\b/);
  });

  it("is empty for boilerplate", () => {
    expect(labelQueries(parseLabelText("GOVERNMENT WARNING 750 ML"))).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  brandKey,
  buildBrandIndex,
  coreName,
  isMatchableCore,
  isAnywhereCore,
  matchBottleBrand,
  matchBottleBrandVia,
  normalizeCountry,
  pickWikidataEntity,
  type WikidataCandidate,
} from "./match";

describe("brand names", () => {
  it("normalizes to a distinctive core", () => {
    expect(coreName("The Glenlivet Distillery")).toBe("glenlivet");
    expect(coreName("Maker’s Mark Distillery")).toBe("makers mark");
    expect(coreName("Gordon & MacPhail")).toBe("gordon macphail");
    expect(coreName("Ardbèg")).toBe("ardbeg");
    expect(brandKey("Buffalo Trace Distillery")).toBe("buffalo-trace");
    expect(brandKey("A.D. Rattray")).toBe("ad-rattray");
  });
  it("refuses generic or tiny names", () => {
    for (const n of ["old", "john", "single", "royal", "12", "ab"]) expect(isMatchableCore(n)).toBe(false);
    for (const n of ["jura", "arran", "glen moray", "old elk"]) expect(isMatchableCore(n)).toBe(true);
  });
  it("folds country spellings", () => {
    expect(normalizeCountry("United States of America")).toBe("usa");
    expect(normalizeCountry("Scotland")).toBe("uk");
    expect(normalizeCountry("United Kingdom")).toBe("uk");
    expect(normalizeCountry(null)).toBeNull();
  });
});

describe("matchBottleBrand", () => {
  const index = buildBrandIndex([
    { key: "glen-moray", name: "Glen Moray" },
    { key: "glen", name: "Glen" }, // generic: never indexed
    { key: "old-elk", name: "Old Elk" },
    { key: "buffalo-trace", name: "Buffalo Trace Distillery", distilleryId: "buffalo-trace" },
    { key: "jura", name: "Jura", aliases: ["Isle of Jura"] },
    { key: "gordon-macphail", name: "Gordon & MacPhail" },
    { key: "gordon-macphail-dup", name: "Gordon and MacPhail" }, // same core: first writer wins
  ]);
  it("prefers the distillery link", () => {
    expect(matchBottleBrand({ name: "Eagle Rare 10 Year", distilleryId: "buffalo-trace" }, index)).toBe("buffalo-trace");
  });
  it("takes the longest brand the name starts with", () => {
    expect(matchBottleBrand({ name: "Glen Moray 15 Year Old" }, index)).toBe("glen-moray");
    expect(matchBottleBrand({ name: "Old Elk Wheated Bourbon" }, index)).toBe("old-elk");
    expect(matchBottleBrand({ name: "Isle of Jura 10" }, index)).toBe("jura");
    expect(matchBottleBrand({ name: "Gordon and MacPhail Connoisseurs Choice" }, index)).toBe("gordon-macphail");
  });
  it("only matches at the start, on whole words", () => {
    expect(matchBottleBrand({ name: "Signatory Glen Moray 1990" }, index)).toBeNull();
    expect(matchBottleBrand({ name: "Glenmorangie Original" }, index)).toBeNull();
    expect(matchBottleBrand({ name: "Old Forester 1920" }, index)).toBeNull();
    expect(matchBottleBrand({ name: "Juranon Reserve" }, index)).toBeNull();
  });
});

describe("pickWikidataEntity", () => {
  const cand = (over: Partial<WikidataCandidate>): WikidataCandidate => ({
    id: "Q1",
    label: "X",
    aliases: [],
    countries: [],
    instanceOf: ["Q10373548"],
    ...over,
  });
  it("matches name + class + country", () => {
    const glen = cand({ id: "Q911587", label: "Glenfiddich Distillery", countries: ["United Kingdom"] });
    const award = cand({ id: "Q5568500", label: "Glenfiddich", instanceOf: ["Q618779"] });
    expect(pickWikidataEntity({ name: "Glenfiddich", country: "Scotland" }, [award, glen])?.id).toBe("Q911587");
  });
  it("rejects a country contradiction", () => {
    const usa = cand({ id: "Q2", label: "Westland Distillery", countries: ["United States of America"] });
    expect(pickWikidataEntity({ name: "Westland", country: "Scotland" }, [usa])).toBeNull();
    expect(pickWikidataEntity({ name: "Westland", country: "USA" }, [usa])?.id).toBe("Q2");
  });
  it("matches on an alias", () => {
    const jd = cand({ id: "Q3", label: "Jack Daniel Distillery", aliases: ["Jack Daniel's"], instanceOf: ["Q1251750"] });
    expect(pickWikidataEntity({ name: "Jack Daniel's" }, [jd])?.id).toBe("Q3");
  });
  it("refuses an ambiguous tie but lets a distillery beat a business", () => {
    const a = cand({ id: "Qa", label: "Arran", instanceOf: ["Q4830453"] });
    const b = cand({ id: "Qb", label: "Arran", instanceOf: ["Q6881511"] });
    expect(pickWikidataEntity({ name: "Arran" }, [a, b])).toBeNull();
    const d = cand({ id: "Qd", label: "Arran Distillery", instanceOf: ["Q10373548"] });
    expect(pickWikidataEntity({ name: "Arran" }, [a, d])?.id).toBe("Qd");
  });
  it("never matches a person or place of the same name", () => {
    const human = cand({ id: "Qh", label: "Johnnie Walker", instanceOf: ["Q5"] });
    expect(pickWikidataEntity({ name: "Johnnie Walker" }, [human])).toBeNull();
  });
});

describe("matchBottleBrand — bottler markers and mid-name names", () => {
  const index = buildBrandIndex([
    { key: "signatory-vintage", name: "Signatory Vintage", markers: ["Signatory Vintage", "Signatory", "Un-Chillfiltered Collection"], anywhere: true },
    { key: "douglas-laing", name: "Douglas Laing", markers: ["Old Particular", "Big Peat"], anywhere: true },
    { key: "gordon-macphail", name: "Gordon & MacPhail", markers: ["G&M", "Connoisseurs Choice"], anywhere: true },
    { key: "caol-ila", name: "Caol Ila", distilleryId: "caol-ila", anywhere: true },
    { key: "cask-strength", name: "Cask Strength", anywhere: true }, // descriptive: never mid-name
    { key: "wd-only", name: "Rare Breed" }, // Wikidata-only: prefix only
  ]);
  it("drops a leading vintage or age before the prefix match", () => {
    expect(matchBottleBrandVia({ name: "1990 Caol Ila Single Malt" }, index)).toEqual({ key: "caol-ila", via: "prefix" });
    expect(matchBottleBrand({ name: "12 Year Old Caol Ila" }, index)).toBe("caol-ila");
  });
  it("files a bottler marker anywhere in the name", () => {
    expect(matchBottleBrandVia({ name: "Mortlach 1995 Signatory Vintage Cask 123" }, index)).toEqual({ key: "signatory-vintage", via: "marker" });
    expect(matchBottleBrand({ name: "Mortlach 20 Year Old Particular" }, index)).toBe("douglas-laing");
    expect(matchBottleBrand({ name: "Linkwood 1999 Connoisseurs Choice" }, index)).toBe("gordon-macphail");
    expect(matchBottleBrand({ name: "Glen Elgin G&M 2008" }, index)).toBe("gordon-macphail");
  });
  it("matches a distinctive multi-word curated name mid-name", () => {
    expect(matchBottleBrandVia({ name: "Single Cask Caol Ila 12" }, index)).toEqual({ key: "caol-ila", via: "anywhere" });
  });
  it("still prefers the distillery link and the prefix", () => {
    expect(matchBottleBrandVia({ name: "Caol Ila 1990 Signatory", distilleryId: "caol-ila" }, index)?.via).toBe("distillery");
    expect(matchBottleBrand({ name: "Caol Ila 1990 Signatory" }, index)).toBe("caol-ila");
  });
  it("never matches descriptive or Wikidata-only names mid-name", () => {
    expect(matchBottleBrand({ name: "Buffalo Trace Cask Strength" }, index)).toBeNull();
    expect(matchBottleBrand({ name: "Wild Turkey Rare Breed" }, index)).toBeNull();
    expect(matchBottleBrand({ name: "Particular Old Reserve" }, index)).toBeNull();
    expect(isAnywhereCore("cask strength")).toBe(false);
    expect(isAnywhereCore("single malt")).toBe(false);
    expect(isAnywhereCore("caol ila")).toBe(true);
  });
});

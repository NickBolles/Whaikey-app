import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeOregonRecord,
  OREGON_PRICING_URL,
  fetchOregonCandidates,
  latestAsOfDate,
  oregonRowsToCandidates,
  refineOregonCategory,
  type OregonRow,
} from "./oregon";

const row = (over: Partial<OregonRow>): OregonRow => ({
  AsOfDate: "07/01/2026",
  Description: "TEST BOURBON",
  Category: "DOMESTIC WHISKEY",
  Size: "750 ML",
  Age: "3 YRS",
  Proof: "88",
  PricePerBottle: "$32.95",
  ...over,
});

describe("oregonRowsToCandidates", () => {
  it("maps a whiskey SKU with un-shouted name, age, abv, and price", () => {
    const { candidates } = oregonRowsToCandidates([
      row({ Description: "BAKER'S STRAIGHT 7 YEAR BOURBON", Age: "7 YRS", Proof: "107", PricePerBottle: "$59.95" }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "Baker's Straight 7 Year Bourbon",
      category: "bourbon",
      source: "oregon",
      ageYears: 7,
      abv: 53.5,
      avgPrice: 59.95,
      upcs: [],
    });
  });

  it("only ingests the latest monthly snapshot", () => {
    const { candidates } = oregonRowsToCandidates([
      row({ AsOfDate: "06/01/2026", Description: "OLD MONTH BOURBON" }),
      row({ AsOfDate: "07/01/2026", Description: "NEW MONTH BOURBON" }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("New Month Bourbon");
  });

  it("skips non-whiskey categories and flavored products", () => {
    const { candidates, scanned } = oregonRowsToCandidates([
      row({ Category: "RUM", Description: "SOME RUM" }),
      row({ Category: "VODKA", Description: "SOME VODKA" }),
      row({ Description: "WHISKEY APPLE PIE" }),
    ]);
    expect(scanned).toBe(3);
    expect(candidates).toHaveLength(0);
  });

  it("collapses sizes into one candidate, preferring the 750 ML price", () => {
    const { candidates } = oregonRowsToCandidates([
      row({ Description: "FOUR ROSES SMALL BATCH", Size: "1.75 L", PricePerBottle: "$55.00" }),
      row({ Description: "FOUR ROSES SMALL BATCH", Size: "750 ML", PricePerBottle: "$32.00" }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].avgPrice).toBe(32);
  });
});

describe("refineOregonCategory", () => {
  it("refines DOMESTIC WHISKEY buckets from name cues", () => {
    expect(refineOregonCategory("Eagle Rare Bourbon", "american-other")).toBe("bourbon");
    expect(refineOregonCategory("Rittenhouse Rye", "american-other")).toBe("rye");
    expect(refineOregonCategory("Westward Single Malt", "american-other")).toBe("american-single-malt");
    expect(refineOregonCategory("Jack Daniel's Old No 7", "american-other")).toBe("american-other");
  });

  it("promotes single malts out of the SCOTCH shelf and spots Japanese producers", () => {
    expect(refineOregonCategory("Glenfiddich 12 Year Single Malt", "scotch-blended")).toBe("scotch-single-malt");
    expect(refineOregonCategory("Nikka Coffey Grain", "world")).toBe("japanese");
  });
});

describe("latestAsOfDate", () => {
  it("compares dates by year then month", () => {
    expect(
      latestAsOfDate([
        { AsOfDate: "12/01/2025" },
        { AsOfDate: "07/01/2026" },
        { AsOfDate: "01/01/2026" },
      ]),
    ).toBe("07/01/2026");
  });

  it("returns null when nothing parses", () => {
    expect(latestAsOfDate([{ AsOfDate: "not a date" }, {}])).toBeNull();
  });
});

describe("fetchOregonCandidates", () => {
  it("downloads and parses the CSV export", async () => {
    const csv = [
      '"AsOfDate","Description","Category","Size","Age","Proof","PricePerBottle"',
      '"07/01/2026","ELIJAH CRAIG SMALL BATCH BOURBON","DOMESTIC WHISKEY","750 ML",,"94","$29.95"',
    ].join("\r\n");
    const fetchImpl = (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(OREGON_PRICING_URL);
      return new Response(csv, { status: 200 });
    }) as typeof fetch;
    const { scanned, candidates } = await fetchOregonCandidates(fetchImpl);
    expect(scanned).toBe(1);
    expect(candidates[0]).toMatchObject({
      name: "Elijah Craig Small Batch Bourbon",
      category: "bourbon",
      abv: 47,
      avgPrice: 29.95,
    });
  });

  it("throws with the source URL on HTTP failure", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    await expect(fetchOregonCandidates(fetchImpl)).rejects.toThrow(/503/);
  });
});

describe("Oregon export header drift (catalog-sync regression, Sept 2026)", () => {
  // A verbatim slice of the live export as of 2026-10-25: display-name headers
  // ("As Of Date", "Price Per Bottle"), two monthly snapshots, a vodka and a
  // flavored whiskey that must be filtered out.
  const fixture = readFileSync(join(__dirname, "fixtures", "oregon-pricing-2026-11.csv"), "utf8");
  const fetchFixture = (async () => new Response(fixture, { status: 200 })) as unknown as typeof fetch;

  it("reads the renamed headers and yields candidates from the latest month", async () => {
    const { scanned, candidates } = await fetchOregonCandidates(fetchFixture);
    expect(scanned).toBe(9);
    // 5 whiskeys in 11/01/2026; vodka, flavored and the 08/01 rows are dropped.
    expect(candidates).toHaveLength(5);
    expect(candidates.map((c) => c.name)).toContain("1792 Bottle In Bond Bourbon Ksbw");
    expect(candidates.some((c) => /blackberry|vodka|old grand dad|ezra/i.test(c.name))).toBe(false);
    expect(candidates.find((c) => /full proof/i.test(c.name))).toMatchObject({
      category: "bourbon",
      ageYears: 8,
      abv: 62.5,
      avgPrice: 51.95,
    });
  });

  it("maps either header spelling onto the same row", () => {
    const legacy = normalizeOregonRecord({ AsOfDate: "07/01/2026", PricePerBottle: "$1", Description: "X" });
    const display = normalizeOregonRecord({ "As Of Date": "07/01/2026", "Price Per Bottle": "$1", Description: "X" });
    expect(display).toEqual(legacy);
  });

  it("fails loudly instead of returning 0 candidates when a required column disappears", async () => {
    const csv = ['"Date","Description","Category"', '"07/01/2026","EAGLE RARE","DOMESTIC WHISKEY"'].join("\n");
    const fetchImpl = (async () => new Response(csv, { status: 200 })) as unknown as typeof fetch;
    await expect(fetchOregonCandidates(fetchImpl)).rejects.toThrow(/missing column\(s\) AsOfDate/);
  });
});

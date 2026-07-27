import { describe, expect, it } from "vitest";
import {
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

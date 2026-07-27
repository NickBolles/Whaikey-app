import { describe, expect, it } from "vitest";
import {
  BC_CKAN_PACKAGE_URL,
  bcRowsToCandidates,
  fetchBcCandidates,
  newestBcResourceUrl,
  refineBcCategory,
  type BcRow,
} from "./bc";

const row = (over: Partial<BcRow>): BcRow => ({
  ITEM_CATEGORY_NAME: "Spirits",
  ITEM_SUBCATEGORY_NAME: "Whisky",
  ITEM_CLASS_NAME: "Bourbon Whiskey",
  PRODUCT_LONG_NAME: "Buffalo Trace Bourbon",
  PRODUCT_BASE_UPC_NO: "080244009663",
  PRODUCT_LITRES_PER_CONTAINER: "0.75",
  PRODUCT_ALCOHOL_PERCENT: "45",
  ...over,
});

describe("bcRowsToCandidates", () => {
  it("maps a whisky SKU with abv and normalized barcode, and no CAD price", () => {
    const { candidates } = bcRowsToCandidates([row({})]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "Buffalo Trace Bourbon",
      category: "bourbon",
      source: "bc",
      abv: 45,
      avgPrice: null,
      upcs: ["080244009663"],
    });
  });

  it("skips other subcategories, liqueurs, and flavored whisky", () => {
    const { candidates } = bcRowsToCandidates([
      row({ ITEM_SUBCATEGORY_NAME: "Vodka", ITEM_CLASS_NAME: "Vodka" }),
      row({ ITEM_CLASS_NAME: "Whiskey Liqueurs" }),
      row({ ITEM_CLASS_NAME: "Flavoured Whisky" }),
      row({ PRODUCT_LONG_NAME: "Crown Royal Apple" }),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("only keeps barcodes from the 0.75 L container", () => {
    const { candidates } = bcRowsToCandidates([
      row({ PRODUCT_LITRES_PER_CONTAINER: "1.14", PRODUCT_BASE_UPC_NO: "087000007963" }),
      row({ PRODUCT_LITRES_PER_CONTAINER: "0.75", PRODUCT_BASE_UPC_NO: "080244009663" }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].upcs).toEqual(["080244009663"]);
  });

  it("drops invalid barcodes and out-of-range abv", () => {
    const { candidates } = bcRowsToCandidates([
      row({ PRODUCT_BASE_UPC_NO: "123456789013", PRODUCT_ALCOHOL_PERCENT: "13" }),
    ]);
    expect(candidates[0].upcs).toEqual([]);
    expect(candidates[0].abv).toBeNull();
  });

  it("parses an age statement out of the product name", () => {
    const { candidates } = bcRowsToCandidates([
      row({
        ITEM_CLASS_NAME: "Single Malt Scotch Whisky",
        PRODUCT_LONG_NAME: "GLENFIDDICH 12 YEAR OLD",
      }),
    ]);
    expect(candidates[0].ageYears).toBe(12);
    expect(candidates[0].category).toBe("scotch-single-malt");
  });
});

describe("refineBcCategory", () => {
  it("spots Japanese producers hiding in Other Country Whisky", () => {
    expect(refineBcCategory("Hibiki Japanese Harmony", "world")).toBe("japanese");
  });
  it("refines American Whiskey from name cues", () => {
    expect(refineBcCategory("Sazerac Rye", "american-other")).toBe("rye");
  });
});

describe("newestBcResourceUrl", () => {
  it("prefers the most recently modified CSV resource", () => {
    const url = newestBcResourceUrl({
      result: {
        resources: [
          { url: "https://x/march.csv", format: "csv", last_modified: "2026-03-02T00:00:00" },
          { url: "https://x/april.csv", format: "csv", last_modified: "2026-04-01T00:00:00" },
          { url: "https://x/readme.pdf", format: "pdf", last_modified: "2026-05-01T00:00:00" },
        ],
      },
    });
    expect(url).toBe("https://x/april.csv");
  });

  it("returns null for malformed metadata", () => {
    expect(newestBcResourceUrl({})).toBeNull();
  });
});

describe("fetchBcCandidates", () => {
  it("resolves the newest resource via CKAN then parses the CSV", async () => {
    const csv = [
      "ITEM_CATEGORY_NAME,ITEM_SUBCATEGORY_NAME,ITEM_CLASS_NAME,PRODUCT_LONG_NAME,PRODUCT_BASE_UPC_NO,PRODUCT_LITRES_PER_CONTAINER,PRODUCT_ALCOHOL_PERCENT",
      "Spirits,Whisky,Canadian Whisky,LOT 40 RYE,080244009663,0.75,43",
    ].join("\n");
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url) === BC_CKAN_PACKAGE_URL) {
        return Response.json({
          result: { resources: [{ url: "https://x/latest.csv", format: "csv", created: "2026-04-01" }] },
        });
      }
      expect(String(url)).toBe("https://x/latest.csv");
      return new Response(csv, { status: 200 });
    }) as typeof fetch;
    const { candidates } = await fetchBcCandidates(fetchImpl);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: "Lot 40 Rye", category: "canadian", abv: 43 });
  });

  it("throws when the package has no CSV resources", async () => {
    const fetchImpl = (async () => Response.json({ result: { resources: [] } })) as typeof fetch;
    await expect(fetchBcCandidates(fetchImpl)).rejects.toThrow(/no CSV/);
  });
});

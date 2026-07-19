import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  IOWA_PRODUCTS_URL,
  fetchIowaCandidates,
  iowaRowsToCandidates,
  parseIowaRows,
  refineIowaCategory,
  unzipIowaPayload,
  type IowaProductRow,
} from "./iowa";

const row = (over: Partial<IowaProductRow>): IowaProductRow => ({
  item_no: "10000",
  category_name: "Straight Bourbon Whiskies",
  im_desc: "Test Bourbon",
  bottle_volume_ml: 750,
  age: "0",
  proof: 90,
  upc: "080244002145",
  state_bottle_retail: 29.99,
  ...over,
});

describe("iowaRowsToCandidates", () => {
  it("maps a bourbon SKU with abv, price, and normalized UPC", () => {
    const { candidates } = iowaRowsToCandidates([
      row({ im_desc: "Eagle Rare 10YR", age: "10", proof: 90 }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "Eagle Rare 10 Year",
      category: "bourbon",
      source: "iowa",
      ageYears: 10,
      abv: 45,
      avgPrice: 29.99,
      upcs: ["080244002145"],
    });
  });

  it("skips non-whiskey categories, liqueurs, flavored, and barrel picks", () => {
    const { candidates, scanned } = iowaRowsToCandidates([
      row({ category_name: "Imported Vodkas", im_desc: "Some Vodka" }),
      row({ category_name: "Whiskey Liqueur", im_desc: "Fireball Cinnamon Whiskey" }),
      row({ category_name: "Canadian Whiskies", im_desc: "Black Velvet Apple" }),
      row({ category_name: "Tennessee Whiskies", im_desc: "BP George Dickel 15 Yr Single Barrel" }),
      row({ category_name: "Temporary & Specialty Packages", im_desc: "Gift Pack Bourbon" }),
    ]);
    expect(scanned).toBe(5);
    expect(candidates).toHaveLength(0);
  });

  it("collapses sizes into one candidate, preferring the 750ml price and barcode", () => {
    const { candidates } = iowaRowsToCandidates([
      row({ im_desc: "Four Roses Small Batch", bottle_volume_ml: 1750, state_bottle_retail: 55, upc: "083664867254" }),
      row({ im_desc: "Four Roses Small Batch", bottle_volume_ml: 750, state_bottle_retail: 32, upc: "083664004607" }),
      row({ im_desc: "Four Roses Small Batch Mini", bottle_volume_ml: 50, state_bottle_retail: 3 }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].avgPrice).toBe(32);
    expect(candidates[0].upcs).toEqual(["083664004607"]);
  });

  it("strips the HA allocation prefix so rows match the real product", () => {
    const { candidates } = iowaRowsToCandidates([
      row({ category_name: "Scotch Whiskies", im_desc: "HA Yamazaki Whisky 12 Year" }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("Yamazaki Whisky 12 Year");
    expect(candidates[0].category).toBe("japanese");
  });

  it("drops invalid barcodes", () => {
    const { candidates } = iowaRowsToCandidates([row({ upc: "123456789013" })]);
    expect(candidates[0].upcs).toEqual([]);
  });
});

describe("refineIowaCategory", () => {
  it("reroutes shelving-bucket misfits by name", () => {
    expect(refineIowaCategory("Nikka Days Japanese Whisky", "american-other")).toBe("japanese");
    expect(refineIowaCategory("Arran 10 Year Scotch", "scotch-blended")).toBe("scotch-blended");
    expect(refineIowaCategory("Aberfeldy 16 Year Single Malt", "scotch-blended")).toBe(
      "scotch-single-malt",
    );
    expect(refineIowaCategory("Balcones Texas 1 Single Malt", "american-other")).toBe(
      "american-single-malt",
    );
    expect(refineIowaCategory("Keepers Heart Irish + American", "american-other")).toBe("irish");
    expect(refineIowaCategory("Seagrams 7 Crown", "american-other")).toBe("american-other");
  });
});

describe("fetchIowaCandidates", () => {
  it("downloads, unzips, and parses the NDJSON payload", async () => {
    const ndjson =
      [row({ im_desc: "Test Bourbon A" }), row({ im_desc: "Test Bourbon B", item_no: "10001" })]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n";
    const zip = zipSync({ "iowa_liquor_products_1029_rows.json": strToU8(ndjson) });
    const fetchImpl = (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(IOWA_PRODUCTS_URL);
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as typeof fetch;

    const { scanned, candidates } = await fetchIowaCandidates(fetchImpl);
    expect(scanned).toBe(2);
    expect(candidates.map((c) => c.name).sort()).toEqual(["Test Bourbon A", "Test Bourbon B"]);
  });

  it("throws a clear error on HTTP failure", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    await expect(fetchIowaCandidates(fetchImpl)).rejects.toThrow(/HTTP 503/);
  });
});

describe("unzip/parse robustness", () => {
  it("tolerates malformed NDJSON lines", () => {
    const rows = parseIowaRows('{"im_desc":"ok"}\nnot json\n\n{"im_desc":"ok2"}');
    expect(rows).toHaveLength(2);
  });

  it("throws on an empty archive", () => {
    expect(() => unzipIowaPayload(zipSync({}))).toThrow(/no files/);
  });
});

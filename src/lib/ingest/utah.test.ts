import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  UTAH_PRODUCT_LIST_PAGE,
  fetchUtahCandidates,
  findUtahWorkbookUrl,
  readXlsxRows,
  refineUtahCategory,
  utahRowsToCandidates,
} from "./utah";

/** Build a minimal inline-string XLSX like Utah's (no sharedStrings). */
function buildXlsx(rows: string[][]): Uint8Array {
  const colName = (i: number): string => {
    let name = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
      name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    }
    return name;
  };
  const body = rows
    .map(
      (cells, r) =>
        `<row r="${r + 1}">` +
        cells
          .map((value, c) =>
            /^\d+(\.\d+)?$/.test(value)
              ? `<c r="${colName(c)}${r + 1}"><v>${value}</v></c>`
              : `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t>${value}</t></is></c>`,
          )
          .join("") +
        `</row>`,
    )
    .join("");
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  return zipSync({
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook/>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  });
}

const HEADER = [
  "CSC",
  "Description",
  "Div",
  "Dept",
  "Class",
  "Size",
  "Retail Price",
  "Item Status",
  "On Spa",
  "Vendor Name",
  "Vendor Cd",
  "Div Name",
  "Dept Name",
  "Class name",
];

const product = (over: Partial<Record<"desc" | "size" | "price" | "cls", string>>): string[] => [
  "000159",
  over.desc ?? "TEST BOURBON 750ml",
  "Y",
  "YB",
  "YBA",
  over.size ?? "750",
  over.price ?? "29.99",
  "A",
  "No",
  "SOME VENDOR",
  "000250",
  "SPIRITS - Y",
  "WHISKEY",
  over.cls ?? "WHISKEY - BOURBON & TENNESSEE",
];

describe("readXlsxRows", () => {
  it("reads inline strings and numeric cells with explicit references", () => {
    const rows = readXlsxRows(buildXlsx([["Name", "Price"], ["ELIJAH CRAIG", "29.99"]]));
    expect(rows).toEqual([
      ["Name", "Price"],
      ["ELIJAH CRAIG", "29.99"],
    ]);
  });

  it("throws when the archive has no worksheet", () => {
    const zip = zipSync({ "xl/workbook.xml": strToU8("<workbook/>") });
    expect(() => readXlsxRows(zip)).toThrow(/no worksheet/);
  });
});

describe("utahRowsToCandidates", () => {
  it("maps a whiskey row with un-shouted name and stripped embedded size", () => {
    const { candidates } = utahRowsToCandidates([
      ["junk header banner"],
      HEADER,
      product({ desc: "HIGH WEST RENDEZVOUS RYE 750ml", cls: "WHISKEY - RYE", price: "69.99" }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "High West Rendezvous Rye",
      category: "rye",
      source: "utah",
      avgPrice: 69.99,
      upcs: [],
    });
  });

  it("skips flavored classes, gift sets, and unmapped classes", () => {
    const { candidates } = utahRowsToCandidates([
      HEADER,
      product({ desc: "FIREBALL CINNAMON 750ml", cls: "WHISKEY - FLAVORED" }),
      product({ desc: "JACK DANIELS TENN FIRE W/ 2 SHOT G 750ml", cls: "GIFT SETS - SPIRITS" }),
      product({ desc: "SOME SCHNAPPS", cls: "SCHNAPPS - BUTTERSCOTCH" }),
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("collapses sizes, preferring the 750 price", () => {
    const { candidates } = utahRowsToCandidates([
      HEADER,
      product({ desc: "MICHTERS SMALL BATCH 1750ml", size: "1750", price: "89.99" }),
      product({ desc: "MICHTERS SMALL BATCH 750ml", size: "750", price: "49.99" }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].avgPrice).toBe(49.99);
  });

  it("returns nothing when the header row is missing", () => {
    const { candidates } = utahRowsToCandidates([["no", "header", "here"]]);
    expect(candidates).toHaveLength(0);
  });
});

describe("refineUtahCategory", () => {
  it("spots Japanese producers in the import bucket", () => {
    expect(refineUtahCategory("Suntory Toki", "world")).toBe("japanese");
  });
  it("promotes American single malts out of the domestic bucket", () => {
    expect(refineUtahCategory("Stranahan's Single Malt", "american-other")).toBe("american-single-malt");
  });
});

describe("findUtahWorkbookUrl", () => {
  it("finds the fiscal-period workbook link", () => {
    const html = `<a href="https://abs.utah.gov/wp-content/uploads/July-2026-Product-List-FY27-P1.xlsx">this spreadsheet</a>`;
    expect(findUtahWorkbookUrl(html)).toBe(
      "https://abs.utah.gov/wp-content/uploads/July-2026-Product-List-FY27-P1.xlsx",
    );
  });
  it("returns null when the page has no workbook link", () => {
    expect(findUtahWorkbookUrl("<html><body>nothing</body></html>")).toBeNull();
  });
});

describe("fetchUtahCandidates", () => {
  it("discovers the workbook from the page, downloads, and parses it", async () => {
    const xlsx = buildXlsx([HEADER, product({ desc: "BENCHMARK OLD NO 8 750ml" })]);
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url) === UTAH_PRODUCT_LIST_PAGE) {
        return new Response('<a href="https://abs.utah.gov/wp-content/uploads/X-Product-List-FY27.xlsx">x</a>');
      }
      expect(String(url)).toBe("https://abs.utah.gov/wp-content/uploads/X-Product-List-FY27.xlsx");
      return new Response(new Uint8Array(xlsx).buffer as ArrayBuffer, { status: 200 });
    }) as typeof fetch;
    const { candidates } = await fetchUtahCandidates(fetchImpl);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("Benchmark Old No 8");
  });

  it("throws when the page has no workbook link", async () => {
    const fetchImpl = (async () => new Response("<html/>")) as typeof fetch;
    await expect(fetchUtahCandidates(fetchImpl)).rejects.toThrow(/no Product-List/);
  });
});

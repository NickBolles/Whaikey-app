import { describe, expect, it } from "vitest";
import {
  classifyColaRecord,
  colaRecordsToCandidates,
  fetchColaRecords,
  monthChunks,
  parseColaCsv,
  titleCase,
  type ColaRecord,
} from "./cola";

const SAMPLE_CSV = [
  "TTB ID,Permit No.,Serial Number,Completed Date,Fanciful Name,Brand Name,Origin,Class/Type",
  "'26001001000001',DSP-KY-10,26A01,1/5/2026,SMALL BATCH RESERVE,OLD RIVERBEND,50,101",
  "'26001001000002',DSP-MD-3,26A02,1/6/2026,,SAGAMORE SPIRIT RYE,25,142",
  "'26001001000003',BWN-CA-99,26B01,1/7/2026,ESTATE RED,SOME WINERY,05,80",
  '\'26001001000004\',DSP-TN-9,26C01,1/8/2026,"HONEY, TENNESSEE STYLE",BEE WHISKEY,47,640',
  "'26001001000005',DSP-TX-77,26D01,1/9/2026,TEXAS SINGLE MALT WHISKY,LONE OAK,45,199",
].join("\r\n");

describe("parseColaCsv", () => {
  it("parses rows, strips TTB ID quotes, skips the header", () => {
    const records = parseColaCsv(SAMPLE_CSV);
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({
      ttbId: "26001001000001",
      brandName: "OLD RIVERBEND",
      fancifulName: "SMALL BATCH RESERVE",
      classType: "101",
    });
    expect(records[3].fancifulName).toBe("HONEY, TENNESSEE STYLE");
  });

  it("returns empty for empty/garbage input", () => {
    expect(parseColaCsv("")).toEqual([]);
    expect(parseColaCsv("some,short,line")).toEqual([]);
  });
});

const rec = (over: Partial<ColaRecord>): ColaRecord => ({
  ttbId: "26001001000001",
  permitNo: "DSP-KY-10",
  serialNumber: "26A01",
  completedDate: "1/5/2026",
  fancifulName: "",
  brandName: "",
  origin: "50",
  classType: "",
  ...over,
});

describe("classifyColaRecord", () => {
  it("maps known class/type codes directly", () => {
    expect(classifyColaRecord(rec({ classType: "101" }))).toBe("bourbon");
    expect(classifyColaRecord(rec({ classType: "142" }))).toBe("rye");
    expect(classifyColaRecord(rec({ classType: "153" }))).toBe("scotch-single-malt");
  });

  it("falls back to name text for unmapped codes", () => {
    expect(
      classifyColaRecord(rec({ classType: "199", brandName: "LONE OAK TENNESSEE WHISKEY" })),
    ).toBe("american-other");
    expect(
      classifyColaRecord(rec({ classType: "199", fancifulName: "CANADIAN WHISKY" })),
    ).toBe("canadian");
    expect(
      classifyColaRecord(rec({ classType: "148", brandName: "GLEN EXAMPLE", fancifulName: "SINGLE MALT SCOTCH WHISKY" })),
    ).toBe("scotch-single-malt");
  });

  it("returns null for non-whiskey and unclassifiable rows", () => {
    expect(classifyColaRecord(rec({ classType: "80", brandName: "SOME WINERY" }))).toBeNull();
    expect(classifyColaRecord(rec({ classType: "199", brandName: "MYSTERY SPIRIT" }))).toBeNull();
  });
});

describe("colaRecordsToCandidates", () => {
  it("builds title-cased names, skips flavored, dedupes approvals", () => {
    const { candidates, scanned } = colaRecordsToCandidates(parseColaCsv(SAMPLE_CSV));
    expect(scanned).toBe(5);
    expect(candidates.map((c) => c.name).sort()).toEqual([
      "Lone Oak Texas Single Malt Whisky",
      "Old Riverbend Small Batch Reserve",
      "Sagamore Spirit Rye",
    ]);
    const rye = candidates.find((c) => c.name === "Sagamore Spirit Rye");
    expect(rye).toMatchObject({ category: "rye", source: "cola" });
  });

  it("dedupes repeated label approvals of the same product", () => {
    const dup = rec({ classType: "101", brandName: "OLD RIVERBEND", fancifulName: "SMALL BATCH" });
    const { candidates } = colaRecordsToCandidates([dup, { ...dup, ttbId: "26001001000099" }]);
    expect(candidates).toHaveLength(1);
  });
});

describe("titleCase", () => {
  it("handles small words and Mc names", () => {
    expect(titleCase("HENRY MCKENNA SINGLE BARREL")).toBe("Henry McKenna Single Barrel");
    expect(titleCase("BANK OF THE RIVER")).toBe("Bank of the River");
  });
});

describe("monthChunks", () => {
  it("splits a range into calendar months", () => {
    expect(monthChunks("2026-01-15", "2026-03-10")).toEqual([
      ["2026-01-15", "2026-01-31"],
      ["2026-02-01", "2026-02-28"],
      ["2026-03-01", "2026-03-10"],
    ]);
  });

  it("rejects inverted ranges", () => {
    expect(() => monthChunks("2026-03-01", "2026-01-01")).toThrow(/Invalid/);
  });
});

describe("fetchColaRecords", () => {
  it("establishes a session, searches, downloads CSV per month chunk", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("publicSearchColasBasic.do")) {
        return new Response("<html>form</html>", {
          status: 200,
          headers: { "set-cookie": "JSESSIONID=abc123; Path=/colasonline" },
        });
      }
      if (u.includes("publicSearchColasBasicProcess.do")) {
        expect((init?.headers as Record<string, string>).cookie).toBe("JSESSIONID=abc123");
        return new Response("<html>results</html>", { status: 200 });
      }
      if (u.includes("publicSaveSearchResultsToFile.do")) {
        return new Response(SAMPLE_CSV, { status: 200 });
      }
      throw new Error(`unexpected url ${u}`);
    }) as typeof fetch;

    const records = await fetchColaRecords({
      since: "2026-01-01",
      until: "2026-02-15",
      fetchImpl,
      sleep: async () => {},
    });
    // Two month-chunks × 5 rows each.
    expect(records).toHaveLength(10);
    expect(calls.filter((u) => u.includes("publicSaveSearchResultsToFile"))).toHaveLength(2);
    const searches = calls.filter((u) => u.includes("publicSearchColasBasicProcess"));
    expect(searches[0]).toContain("searchCriteria.dateCompletedFrom=01%2F01%2F2026");
    expect(searches[0]).toContain("searchCriteria.dateCompletedTo=01%2F31%2F2026");
    expect(searches[1]).toContain("searchCriteria.dateCompletedFrom=02%2F01%2F2026");
  });

  it("fails with guidance when the registry returns HTML instead of CSV", async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("publicSaveSearchResultsToFile")) {
        return new Response("<html>maintenance page</html>", { status: 200 });
      }
      return new Response("<html>ok</html>", {
        status: 200,
        headers: { "set-cookie": "JSESSIONID=x" },
      });
    }) as typeof fetch;
    await expect(
      fetchColaRecords({ since: "2026-01-01", until: "2026-01-05", fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow(/form (fields )?may have changed|instead of the results CSV/);
  });
});

import { describe, expect, it } from "vitest";
import {
  SYSTEMBOLAGET_MIRROR_URL,
  fetchSystembolagetCandidates,
  systembolagetCategory,
  systembolagetCountry,
  systembolagetProductsToCandidates,
  type SystembolagetProduct,
} from "./systembolaget";

const product = (over: Partial<SystembolagetProduct>): SystembolagetProduct => ({
  productNameBold: "Laphroaig",
  productNameThin: "10 Years",
  producerName: "Laphroaig Distillery",
  categoryLevel2: "Whisky",
  categoryLevel3: "Maltwhisky",
  country: "Storbritannien",
  alcoholPercentage: 43,
  isDiscontinued: false,
  ...over,
});

describe("systembolagetProductsToCandidates", () => {
  it("joins bold/thin names and maps a Scottish malt with age and abv, no SEK price", () => {
    const { candidates } = systembolagetProductsToCandidates([product({})]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "Laphroaig 10 Years",
      category: "scotch-single-malt",
      source: "systembolaget",
      ageYears: 10,
      abv: 43,
      avgPrice: null,
      upcs: [],
    });
  });

  it("skips non-whisky rows, discontinued rows, and unaged malt spirit", () => {
    const { candidates, scanned } = systembolagetProductsToCandidates([
      product({ categoryLevel2: "Öl", categoryLevel3: null }),
      product({ isDiscontinued: true }),
      product({ categoryLevel3: "Maltsprit" }),
    ]);
    expect(scanned).toBe(2); // the beer row is not counted as whisky
    expect(candidates).toHaveLength(0);
  });

  it("parses Swedish age statements (\"10 år\")", () => {
    const { candidates } = systembolagetProductsToCandidates([
      product({ productNameBold: "Ardbeg", productNameThin: "10 år" }),
    ]);
    expect(candidates[0].ageYears).toBe(10);
  });

  it("dedupes identical names", () => {
    const { candidates } = systembolagetProductsToCandidates([product({}), product({})]);
    expect(candidates).toHaveLength(1);
  });
});

describe("systembolagetCountry", () => {
  it("translates Swedish country names to the catalog's English ones", () => {
    expect(systembolagetCountry(product({ country: "Skottland" }))).toBe("Scotland");
    expect(systembolagetCountry(product({ country: "Irland" }))).toBe("Ireland");
    expect(systembolagetCountry(product({ country: "Kanada" }))).toBe("Canada");
    expect(systembolagetCountry(product({ country: "Sverige" }))).toBe("Sweden");
    expect(systembolagetCountry(product({ country: "USA" }))).toBe("USA");
  });

  it("stays null for Storbritannien and unknowns — the category fallback decides", () => {
    // "Storbritannien" doesn't say which whisky nation; a Maltwhisky row still
    // resolves to Scotland via categoryCountry(scotch-single-malt) at insert.
    expect(systembolagetCountry(product({ country: "Storbritannien" }))).toBeNull();
    expect(systembolagetCountry(product({ country: "Mongoliet" }))).toBeNull();
    expect(systembolagetCountry(product({ country: null }))).toBeNull();
  });

  it("carries the mapped country on candidates", () => {
    const { candidates } = systembolagetProductsToCandidates([product({ country: "Japan", categoryLevel3: "Maltwhisky" })]);
    expect(candidates[0]).toMatchObject({ country: "Japan", category: "japanese" });
  });
});

describe("systembolagetCategory", () => {
  const cat = (over: Partial<SystembolagetProduct>): ReturnType<typeof systembolagetCategory> =>
    systembolagetCategory(product(over));

  it("maps level-3 buckets by origin country", () => {
    expect(cat({ categoryLevel3: "Bourbon", country: "USA" })).toBe("bourbon");
    expect(cat({ categoryLevel3: "Ryewhisky", country: "USA" })).toBe("rye");
    expect(cat({ categoryLevel3: "Maltwhisky", country: "Storbritannien" })).toBe("scotch-single-malt");
    expect(cat({ categoryLevel3: "Maltwhisky", country: "Japan" })).toBe("japanese");
    expect(cat({ categoryLevel3: "Maltwhisky", country: "USA" })).toBe("american-single-malt");
    expect(cat({ categoryLevel3: "Maltwhisky", country: "Danmark" })).toBe("world");
    expect(cat({ categoryLevel3: "Blended whisky", country: "Storbritannien" })).toBe("scotch-blended");
    expect(cat({ categoryLevel3: "Blended whisky", country: "Irland" })).toBe("irish");
    expect(cat({ categoryLevel3: "Annan whisky", country: "Kanada" })).toBe("canadian");
    expect(cat({ categoryLevel3: "Tennessee whiskey", country: "USA" })).toBe("american-other");
  });

  it("returns null for unrecognized buckets", () => {
    expect(cat({ categoryLevel3: "Maltsprit" })).toBeNull();
  });
});

describe("fetchSystembolagetCandidates", () => {
  it("downloads and parses the mirror array", async () => {
    const fetchImpl = (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(SYSTEMBOLAGET_MIRROR_URL);
      return Response.json([product({})]);
    }) as typeof fetch;
    const { candidates } = await fetchSystembolagetCandidates(fetchImpl);
    expect(candidates).toHaveLength(1);
  });

  it("throws on a non-array payload", async () => {
    const fetchImpl = (async () => Response.json({ nope: true })) as typeof fetch;
    await expect(fetchSystembolagetCandidates(fetchImpl)).rejects.toThrow(/non-array/);
  });
});

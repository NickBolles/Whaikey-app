import { describe, expect, it } from "vitest";
import {
  SYSTEMBOLAGET_MIRROR_URL,
  fetchSystembolagetCandidates,
  systembolagetCategory,
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

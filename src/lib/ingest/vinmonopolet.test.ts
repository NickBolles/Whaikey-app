import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VINMONOPOLET_PRODUCTS_URL,
  VINMONOPOLET_SEARCH_TERMS,
  fetchVinmonopoletCandidates,
  vinmonopoletCategory,
  vinmonopoletProductsToCandidates,
  type VinmonopoletProduct,
} from "./vinmonopolet";

const product = (id: string, name: string): VinmonopoletProduct => ({
  basic: { productId: id, productShortName: name },
});

describe("vinmonopoletCategory", () => {
  it("classifies from name cues alone", () => {
    expect(vinmonopoletCategory("Maker's Mark Bourbon")).toBe("bourbon");
    expect(vinmonopoletCategory("Rittenhouse Straight Rye Whisky")).toBe("rye");
    expect(vinmonopoletCategory("Johnnie Walker Black Scotch Whisky")).toBe("scotch-blended");
    expect(vinmonopoletCategory("Glen Ord Scotch Single Malt")).toBe("scotch-single-malt");
    expect(vinmonopoletCategory("Jameson Irish Whiskey")).toBe("irish");
    expect(vinmonopoletCategory("Nikka From The Barrel")).toBe("japanese");
    expect(vinmonopoletCategory("The Glenlivet 12 YO Single Malt")).toBe("world");
  });

  it("rejects non-whisky spirits the searches catch", () => {
    expect(vinmonopoletCategory("Chase Islay Whisky Cask Aged Vodka")).toBeNull();
    expect(vinmonopoletCategory("Old Tom Barrel Aged Gin")).toBeNull();
    expect(vinmonopoletCategory("Løiten Aquavit")).toBeNull();
    expect(vinmonopoletCategory("Cellier des Dauphins Réserve")).toBeNull();
  });
});

describe("vinmonopoletProductsToCandidates", () => {
  it("maps names with age statements and dedupes by slug", () => {
    const { candidates } = vinmonopoletProductsToCandidates([
      product("1", "Dalwhinnie Single Malt 15 Years Old"),
      product("2", "Dalwhinnie Single Malt 15 Years Old"),
      product("3", "Benromach 10 YO Single Malt"),
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      name: "Dalwhinnie Single Malt 15 Years Old",
      source: "vinmonopolet",
      ageYears: 15,
      abv: null,
      avgPrice: null,
      upcs: [],
    });
    expect(candidates[1].ageYears).toBe(10);
  });

  it("skips empty names and flavored products", () => {
    const { candidates } = vinmonopoletProductsToCandidates([
      product("1", ""),
      product("2", "Honey Malt Whisky Likør"),
      { basic: { productId: "3" } },
    ]);
    expect(candidates).toHaveLength(0);
  });
});

describe("fetchVinmonopoletCandidates", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws with setup guidance when the key is missing", async () => {
    vi.stubEnv("VINMONOPOLET_API_KEY", "");
    await expect(fetchVinmonopoletCandidates()).rejects.toThrow(/VINMONOPOLET_API_KEY/);
  });

  it("unions every search term, sends the key header, and dedupes by productId", async () => {
    vi.stubEnv("VINMONOPOLET_API_KEY", "test-key");
    const seenTerms: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      expect(String(url).startsWith(VINMONOPOLET_PRODUCTS_URL)).toBe(true);
      expect((init?.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("test-key");
      const term = u.searchParams.get("productShortNameContains")!;
      seenTerms.push(term);
      // The same bottle comes back for both "whisky" and "malt".
      return Response.json(
        term === "whisky" || term === "malt"
          ? [product("42", "Highland Peat Single Malt Whisky")]
          : [],
      );
    }) as typeof fetch;

    const { scanned, candidates } = await fetchVinmonopoletCandidates(fetchImpl);
    expect(seenTerms).toEqual([...VINMONOPOLET_SEARCH_TERMS]);
    expect(scanned).toBe(2);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: "Highland Peat Single Malt Whisky", category: "world" });
  });

  it("throws on HTTP failure with the failing term", async () => {
    vi.stubEnv("VINMONOPOLET_API_KEY", "test-key");
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    await expect(fetchVinmonopoletCandidates(fetchImpl)).rejects.toThrow(/401.*whisky/);
  });
});

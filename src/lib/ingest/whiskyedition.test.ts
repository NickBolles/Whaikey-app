import { describe, expect, it } from "vitest";
import {
  WHISKY_EDITION_API_URL,
  fetchWhiskyEditionCandidates,
  whiskyEditionCategory,
  whiskyEditionReviewsToCandidates,
  type WhiskyEditionReview,
} from "./whiskyedition";

const review = (over: Partial<WhiskyEditionReview> & { metadata?: WhiskyEditionReview["metadata"] }): WhiskyEditionReview => ({
  name: "Ledaig 5 Years (2020/2025) - James Eadie",
  metadata: {
    country: "Scotland",
    region: "Isle of Mull",
    age: 5,
    abv: 52.6,
    distillery: "Tobermory",
    type: "Single Malt",
    ...over.metadata,
  },
  ...over,
});

describe("whiskyEditionReviewsToCandidates", () => {
  it("maps a review's structured metadata into a candidate with region", () => {
    const { candidates } = whiskyEditionReviewsToCandidates([review({})]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: "Ledaig 5 Years (2020/2025) - James Eadie",
      category: "scotch-single-malt",
      source: "whiskyedition",
      region: "Isle of Mull",
      ageYears: 5,
      abv: 52.6,
      avgPrice: null,
    });
  });

  it("skips reviews without name or category signal and dedupes", () => {
    const { candidates } = whiskyEditionReviewsToCandidates([
      review({ name: undefined }),
      { name: "Mystery Dram", metadata: {} },
      review({}),
      review({}),
    ]);
    expect(candidates).toHaveLength(1);
  });
});

describe("whiskyEditionCategory", () => {
  const cat = (metadata: NonNullable<WhiskyEditionReview["metadata"]>): ReturnType<typeof whiskyEditionCategory> =>
    whiskyEditionCategory({ name: "x", metadata });

  it("maps type + country to the taxonomy", () => {
    expect(cat({ type: "Single Malt", country: "Scotland" })).toBe("scotch-single-malt");
    expect(cat({ type: "Blended Malt", country: "Scotland" })).toBe("scotch-blended");
    expect(cat({ type: "Bourbon", country: "USA" })).toBe("bourbon");
    expect(cat({ type: "Rye", country: "USA" })).toBe("rye");
    expect(cat({ type: "Single Malt", country: "Ireland" })).toBe("irish");
    expect(cat({ type: "Single Malt", country: "Japan" })).toBe("japanese");
    expect(cat({ type: "Single Malt", country: "USA" })).toBe("american-single-malt");
    expect(cat({ type: "Single Malt", country: "Germany" })).toBe("world");
  });
});

describe("fetchWhiskyEditionCandidates", () => {
  it("pages through the API until the total is reached", async () => {
    const pages: Record<string, unknown> = {
      [`${WHISKY_EDITION_API_URL}?page=1`]: {
        ok: true,
        page: 1,
        per_page: 1,
        total: 2,
        items: [review({})],
      },
      [`${WHISKY_EDITION_API_URL}?page=2`]: {
        ok: true,
        page: 2,
        per_page: 1,
        total: 2,
        items: [review({ name: "Glenburgie 9 Years - Claxton's" })],
      },
    };
    const fetched: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      fetched.push(String(url));
      return Response.json(pages[String(url)]);
    }) as typeof fetch;
    const { scanned, candidates } = await fetchWhiskyEditionCandidates(fetchImpl);
    expect(fetched).toHaveLength(2);
    expect(scanned).toBe(2);
    expect(candidates).toHaveLength(2);
  });

  it("throws on HTTP failure", async () => {
    const fetchImpl = (async () => new Response("down", { status: 500 })) as typeof fetch;
    await expect(fetchWhiskyEditionCandidates(fetchImpl)).rejects.toThrow(/500/);
  });
});

import { describe, expect, it } from "vitest";
import { extractTastingNote } from "./extract";
import { makeFakeAnthropic, textResponse } from "./testing";

describe("extractTastingNote", () => {
  it("parses fenced JSON, drops invalid leaves, clamps intensities and rating", async () => {
    const fake = makeFakeAnthropic([
      textResponse(
        [
          "```json",
          JSON.stringify({
            nose: "vanilla and oak",
            palate: "sweet caramel",
            finish: "long and spicy",
            flavorTags: { vanilla: 5, unicorn: 2, oak: 2, cinnamon: 0.4 },
            suggestedRating: 4.3,
            servingStyle: "neat",
          }),
          "```",
        ].join("\n"),
      ),
    ]);

    const result = await extractTastingNote("big vanilla, oak, long spicy finish, 4.3/5 neat", fake.client);

    expect(result.nose).toBe("vanilla and oak");
    expect(result.palate).toBe("sweet caramel");
    expect(result.finish).toBe("long and spicy");
    // "unicorn" is not a flavor-wheel leaf → dropped; 5 → 3; 0.4 → 1
    expect(result.flavorTags).toEqual({ vanilla: 3, oak: 2, cinnamon: 1 });
    // 4.3 rounds to nearest half step
    expect(result.suggestedRating).toBe(4.5);
    expect(result.servingStyle).toBe("neat");
  });

  it("clamps out-of-range ratings into 0.5-5", async () => {
    const fake = makeFakeAnthropic([
      textResponse(JSON.stringify({ flavorTags: {}, suggestedRating: 7 })),
    ]);
    const result = await extractTastingNote("perfect 10", fake.client);
    expect(result.suggestedRating).toBe(5);

    const fakeLow = makeFakeAnthropic([
      textResponse(JSON.stringify({ flavorTags: {}, suggestedRating: 0.1 })),
    ]);
    const low = await extractTastingNote("awful", fakeLow.client);
    expect(low.suggestedRating).toBe(0.5);
  });

  it("nulls non-numeric ratings and unknown serving styles", async () => {
    const fake = makeFakeAnthropic([
      textResponse(
        JSON.stringify({
          flavorTags: { peat: 3 },
          suggestedRating: "not sure",
          servingStyle: "flaming shot",
        }),
      ),
    ]);
    const result = await extractTastingNote("smoky", fake.client);
    expect(result.suggestedRating).toBeNull();
    expect(result.servingStyle).toBeNull();
    expect(result.flavorTags).toEqual({ peat: 3 });
  });

  it("returns an empty note when the model output is not JSON", async () => {
    const fake = makeFakeAnthropic([textResponse("Sorry, I can't help with that.")]);
    const result = await extractTastingNote("gibberish", fake.client);
    expect(result).toEqual({
      nose: null,
      palate: null,
      finish: null,
      flavorTags: {},
      suggestedRating: null,
      servingStyle: null,
    });
  });

  it("handles JSON embedded in prose", async () => {
    const fake = makeFakeAnthropic([
      textResponse('Here is the extraction: {"nose": "honey", "flavorTags": {"honey": 2}} Hope that helps!'),
    ]);
    const result = await extractTastingNote("honey nose", fake.client);
    expect(result.nose).toBe("honey");
    expect(result.flavorTags).toEqual({ honey: 2 });
  });
});

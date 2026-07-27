import { describe, expect, it } from "vitest";
import {
  cleanProductName,
  looksFlavored,
  matchKey,
  parseAgeText,
  parseAgeYears,
  proofToAbv,
  slugify,
  unshoutName,
} from "./normalize";

describe("cleanProductName", () => {
  it("strips packaging and program noise", () => {
    expect(cleanProductName("Gentleman Jack w/Sour Mix")).toBe("Gentleman Jack");
    expect(cleanProductName("Black Velvet PET")).toBe("Black Velvet");
    expect(cleanProductName("Black Velvet Mini")).toBe("Black Velvet");
    expect(cleanProductName("Ardmore Legacy DISCO")).toBe("Ardmore Legacy");
    expect(cleanProductName("Nikka Coffey Gin USE CODE 28730")).toBe("Nikka Coffey Gin");
    expect(cleanProductName("CM Obtainium Bourbon Whiskey Buy the Barrel")).toBe(
      "CM Obtainium Bourbon Whiskey",
    );
    expect(cleanProductName("Minor Case 6YR Buy the Barrel 105prf")).toBe("Minor Case 6 Year");
    expect(cleanProductName("Shankys Whip Black Irish Gift Tin")).toBe("Shankys Whip Black Irish");
    expect(cleanProductName("Fireball Cinnamon Whiskey Bag in Box")).toBe(
      "Fireball Cinnamon Whiskey",
    );
  });

  it("strips stacked noise tokens", () => {
    expect(cleanProductName("Black Velvet Apple Mini DISCO")).toBe("Black Velvet Apple");
  });

  it("normalizes year abbreviations", () => {
    expect(cleanProductName("Ballantines 17YR")).toBe("Ballantines 17 Year");
    expect(cleanProductName("Aberfeldy 16YR Single Malt")).toBe("Aberfeldy 16 Year Single Malt");
  });

  it("returns null for empty/degenerate names", () => {
    expect(cleanProductName("  ")).toBeNull();
    expect(cleanProductName("BV")).toBeNull();
  });
});

describe("looksFlavored", () => {
  it("flags flavored products", () => {
    expect(looksFlavored("Fireball Cinnamon Whiskey")).toBe(true);
    expect(looksFlavored("Black Velvet Apple")).toBe(true);
    expect(looksFlavored("Elvis Midnight Snack Flavored Whiskey")).toBe(true);
    expect(looksFlavored("Jack Daniel's Tennessee Honey")).toBe(true);
    expect(looksFlavored("Ole Smoky Bourbon Ball Cream Whiskey")).toBe(true);
    expect(looksFlavored("Misunderstood Oatnog Whisky")).toBe(true);
    expect(looksFlavored("Pulteney Stroma Liqueur")).toBe(true);
  });

  it("does not flag plain whiskies with incidental words", () => {
    expect(looksFlavored("Buffalo Trace")).toBe(false);
    expect(looksFlavored("High West Campfire")).toBe(false); // "fire" ≠ flavored
    expect(looksFlavored("Redwood Empire Screaming Titan")).toBe(false); // "cream" inside a word
    expect(looksFlavored("Nikka Coffey Grain Whiskey")).toBe(false); // Coffey still, not coffee
    expect(looksFlavored("Wild Turkey Rare Breed")).toBe(false);
  });
});

describe("proofToAbv / parseAgeYears", () => {
  it("converts proof and rejects implausible values", () => {
    expect(proofToAbv(90)).toBe(45);
    expect(proofToAbv("80")).toBe(40);
    expect(proofToAbv(0)).toBeNull();
    expect(proofToAbv(200)).toBeNull();
    expect(proofToAbv(undefined)).toBeNull();
  });

  it("parses age statements", () => {
    expect(parseAgeYears("12")).toBe(12);
    expect(parseAgeYears("0")).toBeNull();
    expect(parseAgeYears(null)).toBeNull();
    expect(parseAgeYears("99")).toBeNull();
  });
});

describe("slugify", () => {
  it("matches the seed id convention", () => {
    expect(slugify("Wayne Gretzky No. 99 Red Cask")).toBe("wayne-gretzky-no-99-red-cask");
    expect(slugify("W.L. Weller 12 Year")).toBe("w-l-weller-12-year");
  });
});

describe("parseAgeText", () => {
  it("parses textual age statements", () => {
    expect(parseAgeText("3 YRS")).toBe(3);
    expect(parseAgeText("12 Year")).toBe(12);
    expect(parseAgeText("10 år")).toBe(10);
    expect(parseAgeText("7")).toBe(7);
    expect(parseAgeText("NAS")).toBeNull();
    expect(parseAgeText(null)).toBeNull();
  });

  it("delegates numeric input to parseAgeYears bounds", () => {
    expect(parseAgeText(12)).toBe(12);
    expect(parseAgeText(0)).toBeNull();
  });
});

describe("unshoutName", () => {
  it("title-cases ALL-CAPS retail names and keeps possessives", () => {
    expect(unshoutName("BAKER'S STRAIGHT 7 YEAR BOURBON")).toBe("Baker's Straight 7 Year Bourbon");
    expect(unshoutName("ELIJAH CRAIG SMALL BATCH")).toBe("Elijah Craig Small Batch");
  });

  it("leaves mixed-case names untouched and preserves known abbreviations", () => {
    expect(unshoutName("Wayne Gretzky No. 99 Red Cask")).toBe("Wayne Gretzky No. 99 Red Cask");
    expect(unshoutName("COURVOISIER XO")).toBe("Courvoisier XO");
  });

  it("still un-shouts after cleanProductName injects a lowercase 'Year'", () => {
    expect(unshoutName("PENDLETON 20 Year DIRECTOR'S RESERVE")).toBe("Pendleton 20 Year Director's Reserve");
    expect(unshoutName("Thy BOG Single Malt Whisky")).toBe("Thy BOG Single Malt Whisky");
  });
});

describe("matchKey", () => {
  it("collapses cross-source naming variants of the same product", () => {
    const curated = matchKey("Glenlivet 12 Year");
    expect(matchKey("The Glenlivet 12 YO Single Malt")).toBe(curated);
    expect(matchKey("Glenlivet 12 Yrs Single Malt Scotch Whisky")).toBe(curated);
    expect(matchKey("Dalwhinnie Single Malt 15 Years Old")).toBe(matchKey("Dalwhinnie 15 Year"));
    expect(matchKey("Elijah Craig Small Batch Kentucky Straight Bourbon Whiskey")).toBe(
      matchKey("Elijah Craig Small Batch"),
    );
  });

  it("keeps distinct products distinct", () => {
    expect(matchKey("Glenfiddich 12 Year")).not.toBe(matchKey("Glenfiddich 15 Year"));
    expect(matchKey("Old Forester 86")).not.toBe(matchKey("Forester 86"));
    expect(matchKey("Sazerac Rye")).not.toBe(matchKey("Sazerac"));
    expect(matchKey("Jameson Black Barrel")).not.toBe(matchKey("Jameson"));
    expect(matchKey("Wild Turkey 101")).toBe("wild-turkey-101");
  });

  it("keeps filler tokens when they are the distinguishing ones", () => {
    // Brand-only aliases ("Redemption") must not swallow the brand's other
    // expressions when a style word is all that distinguishes them.
    expect(matchKey("Redemption Bourbon")).toBe("redemption-bourbon");
    expect(matchKey("Redemption Bourbon")).not.toBe(matchKey("Redemption Rye"));
    expect(matchKey("Redemption Bourbon")).not.toBe(matchKey("Redemption"));
    // Two real tokens are enough to drop trailing style fillers.
    expect(matchKey("Tin Cup Whiskey")).toBe(matchKey("Tin Cup Straight Bourbon Whiskey"));
  });
});

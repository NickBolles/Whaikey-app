import { describe, expect, it } from "vitest";
import { cleanProductName, looksFlavored, parseAgeYears, proofToAbv, slugify } from "./normalize";

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

import { describe, expect, it } from "vitest";
import { bottleShape, displayImageHosts, displayableImage, liquidTint, monogram, monogramColor } from "@/lib/bottle-art";

describe("bottle imagery policy", () => {
  it("only display_remote sources contribute image hosts", () => {
    expect(
      displayImageHosts([
        { baseUrl: "https://press.example.com", mediaPolicy: "display_remote", mediaHosts: ["cdn.example.com"] },
        { baseUrl: "https://editorial.example.com", mediaPolicy: "link_only" },
        { baseUrl: "https://brand.example.com", mediaPolicy: "review_required" },
        { baseUrl: "not a url", mediaPolicy: "display_remote" },
      ]),
    ).toEqual(["cdn.example.com", "press.example.com"]);
  });
  it("the shipped catalog grants no host today, so nothing is hotlinked", () => {
    expect(displayImageHosts()).toEqual([]);
    expect(displayableImage("https://www.buffalotracedistillery.com/x.png")).toBeNull();
  });
  it("renders an https image only from an allowed host", () => {
    const hosts = ["cdn.example.com"];
    expect(displayableImage("https://cdn.example.com/a.png", hosts)).toBe("https://cdn.example.com/a.png");
    expect(displayableImage("http://cdn.example.com/a.png", hosts)).toBeNull();
    expect(displayableImage("https://evil.example.com/a.png", hosts)).toBeNull();
    expect(displayableImage("::", hosts)).toBeNull();
    expect(displayableImage(null, hosts)).toBeNull();
  });
});

describe("silhouette + monogram", () => {
  it("shapes by style", () => {
    expect(bottleShape("bourbon")).toBe("squat");
    expect(bottleShape("japanese")).toBe("square");
    expect(bottleShape("canadian")).toBe("flask");
    expect(bottleShape("scotch-single-malt")).toBe("tall");
  });
  it("tints by cask, then region, then style", () => {
    expect(liquidTint({ name: "GlenAllachie 12 Oloroso", category: "scotch-single-malt" })).toBe("#7a3420");
    expect(liquidTint({ name: "Taylor Port Finish", category: "bourbon" })).toBe("#7c2a3a");
    expect(liquidTint({ name: "Lagavulin 16", category: "scotch-single-malt", region: "Islay" })).toBe("#8b7340");
    expect(liquidTint({ name: "Blanton's", category: "bourbon" })).toBe("#b4602a");
    for (const c of ["rye", "irish", "japanese", "canadian", "scotch-blended", "world"]) expect(liquidTint({ name: "x", category: c })).toMatch(/^#/);
    expect(liquidTint({ name: "Rum Cask", category: "world" })).toBe("#9a4f22");
  });
  it("monograms from the distillery name, skipping filler words", () => {
    expect(monogram("Buffalo Trace Distillery")).toBe("BT");
    expect(monogram("Lagavulin")).toBe("L");
    expect(monogram("The Macallan")).toBe("M");
    expect(monogram("")).toBe("?");
    expect(monogram(null)).toBe("?");
  });
  it("colours the roundel by region or style", () => {
    expect(monogramColor({ category: "scotch-single-malt", region: "Islay" })).toBe("#4f5d46");
    expect(monogramColor({ category: "scotch-single-malt", region: "Speyside" })).not.toBe(monogramColor({ category: "scotch-single-malt", region: "Islay" }));
    for (const c of ["bourbon", "rye", "american-other", "scotch-single-malt", "scotch-blended", "irish", "japanese", "canadian", "world"])
      expect(monogramColor({ category: c })).toMatch(/^#/);
    expect(monogramColor({ category: "x", region: "Highland" })).toBe("#55473a");
  });
});

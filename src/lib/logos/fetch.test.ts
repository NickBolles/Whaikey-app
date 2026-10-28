import { describe, expect, it } from "vitest";
import {
  commonsLogo,
  foldProducers,
  HostRateLimiter,
  iconCandidates,
  isLogoFileFor,
  isSafeSvg,
  robotsAllows,
  sniffImage,
  websiteLogo,
  type FetchContext,
} from "./fetch";
import { pngBytes, stubFetch } from "./test-utils";

const noWait = new HostRateLimiter(() => 0, async () => {});
const ctx = (routes: Record<string, [number, string, string | Uint8Array]>): FetchContext => ({ fetchImpl: stubFetch(routes), limiter: noWait });

describe("sniffImage", () => {
  it("reads PNG, GIF, JPEG and SVG sizes from the bytes", () => {
    expect(sniffImage(pngBytes(180, 180))).toEqual({ type: "image/png", width: 180, height: 180 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 200, 0, 100, 0, 0, 0]);
    expect(sniffImage(gif)).toEqual({ type: "image/gif", width: 200, height: 100 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 1, 44, 2, 88, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffImage(jpeg)).toEqual({ type: "image/jpeg", width: 600, height: 300 });
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><path d="M0 0h1"/></svg>');
    expect(sniffImage(svg)).toEqual({ type: "image/svg+xml", width: 120, height: 40 });
  });
  it("refuses HTML pretending to be an image and scripted SVG", () => {
    expect(sniffImage(new TextEncoder().encode("<!doctype html><html></html>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'))).toBeNull();
  });
  it("isSafeSvg rejects handlers, external refs and foreign content", () => {
    expect(isSafeSvg('<svg><g onload="x()"/></svg>')).toBe(false);
    expect(isSafeSvg('<svg><image href="https://evil.example/x.png"/></svg>')).toBe(false);
    expect(isSafeSvg("<svg><foreignObject/></svg>")).toBe(false);
    expect(isSafeSvg('<svg><style>@import url(x.css)</style></svg>')).toBe(false);
    expect(isSafeSvg('<svg><use href="#a"/><path fill="url(#g)"/></svg>')).toBe(true);
  });
});

describe("iconCandidates", () => {
  const html = `<html><head>
    <link rel="icon" href="/favicon.ico">
    <link rel="icon" type="image/png" sizes="32x32" href="/f32.png">
    <link rel="icon" type="image/png" sizes="192x192" href="/f192.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="icon" href="http://insecure.example/x.png" sizes="512x512">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","logo":{"@type":"ImageObject","url":"https://cdn.example.com/brand.png"}}]}</script>
  </head></html>`;
  it("ranks JSON-LD logo, apple-touch-icon, SVG icon, big icons; drops .ico, tiny and http", () => {
    expect(iconCandidates(html, "https://brand.example/").map((c) => c.url)).toEqual([
      "https://cdn.example.com/brand.png",
      "https://brand.example/apple.png",
      "https://brand.example/logo.svg",
      "https://brand.example/f192.png",
    ]);
  });
});

describe("robotsAllows", () => {
  it("honours * rules and our own group over *", () => {
    const robots = "User-agent: *\nDisallow: /private\nAllow: /private/ok\n";
    expect(robotsAllows(robots, "/")).toBe(true);
    expect(robotsAllows(robots, "/private/x")).toBe(false);
    expect(robotsAllows(robots, "/private/ok/y")).toBe(true);
    expect(robotsAllows("User-agent: CaskfolkLogoBot\nDisallow: /\n\nUser-agent: *\nAllow: /", "/x")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow:\n", "/x")).toBe(true);
  });
});

describe("isLogoFileFor", () => {
  it("accepts only '<brand> logo' titles", () => {
    expect(isLogoFileFor("File:Glenfiddich logo.svg", "Glenfiddich")).toBe(true);
    expect(isLogoFileFor("File:Glenfiddich Distillery wordmark.png", "The Glenfiddich")).toBe(true);
    expect(isLogoFileFor("File:Glenfiddich bottle logo detail.jpg", "Glenfiddich")).toBe(false);
    expect(isLogoFileFor("File:Old Glenfiddich logo.svg", "Glenfiddich")).toBe(false);
  });
});

describe("foldProducers", () => {
  it("merges SPARQL rows per item and decodes logo file names", () => {
    const rows = [
      { item: { value: "http://www.wikidata.org/entity/Q502268" }, itemLabel: { value: "Johnnie Walker" }, cls: { value: "http://www.wikidata.org/entity/Q80359036" }, countryLabel: { value: "United Kingdom" }, logo: { value: "http://commons.wikimedia.org/wiki/Special:FilePath/Johnnie%20Walker%20wordmark.svg" }, aliases: { value: "JW|Johnnie Walker whisky" } },
      { item: { value: "http://www.wikidata.org/entity/Q502268" }, itemLabel: { value: "Johnnie Walker" }, cls: { value: "http://www.wikidata.org/entity/Q167270" }, web: { value: "http://www.johnniewalker.com/" } },
      { item: { value: "http://www.wikidata.org/entity/Q999" }, itemLabel: { value: "Q999" } },
    ];
    const [jw, ...rest] = foldProducers(rows);
    expect(rest).toHaveLength(0);
    expect(jw).toMatchObject({
      id: "Q502268",
      instanceOf: ["Q80359036", "Q167270"],
      countries: ["United Kingdom"],
      logoFiles: ["Johnnie Walker wordmark.svg"],
      website: "https://www.johnniewalker.com/",
      aliases: ["JW", "Johnnie Walker whisky"],
    });
  });
});

describe("commonsLogo", () => {
  const info = (license: string) =>
    JSON.stringify({
      query: { pages: { "1": { title: "File:X logo.svg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/thumb/x.png", descriptionurl: "https://commons.wikimedia.org/wiki/File:X_logo.svg", extmetadata: { LicenseShortName: { value: license }, Artist: { value: "<a>Jane</a>" }, AttributionRequired: { value: "true" } } }] } } },
    });
  it("downloads the PNG thumbnail of a free file with its license", async () => {
    const logo = await commonsLogo(ctx({ "https://commons.wikimedia.org/w/api.php": [200, "application/json", info("CC BY-SA 4.0")], "https://upload.wikimedia.org/": [200, "image/png", pngBytes(256, 80)] }), "X logo.svg");
    expect(logo).toMatchObject({ source: "wikidata", contentType: "image/png", width: 256, height: 80, license: { license: "CC BY-SA 4.0", attributionRequired: true }, attributionUrl: "https://commons.wikimedia.org/wiki/File:X_logo.svg" });
    expect(logo?.attribution).toContain("Jane");
  });
  it("refuses a file whose license is not free", async () => {
    expect(await commonsLogo(ctx({ "https://commons.wikimedia.org/w/api.php": [200, "application/json", info("Fair use")], "https://upload.wikimedia.org/": [200, "image/png", pngBytes(256, 80)] }), "X logo.svg")).toBeNull();
  });
});

describe("websiteLogo", () => {
  const home = '<html><head><title>Old Elk Bourbon</title><link rel="apple-touch-icon" href="/apple.png"></head><body>Old Elk</body></html>';
  it("takes the apple-touch-icon under nominative use", async () => {
    const logo = await websiteLogo(ctx({ "https://brand.example/robots.txt": [200, "text/plain", "User-agent: *\nAllow: /"], "https://brand.example/apple.png": [200, "image/png", pngBytes(180, 180)], "https://brand.example/": [200, "text/html", home] }), "https://brand.example/");
    expect(logo).toMatchObject({ source: "website", license: { license: "nominative-use", attributionRequired: false }, width: 180, attribution: "brand.example" });
  });
  it("respects robots.txt, tiny icons and a page that isn't the brand's", async () => {
    const routes = { "https://brand.example/robots.txt": [200, "text/plain", "User-agent: *\nDisallow: /"], "https://brand.example/apple.png": [200, "image/png", pngBytes(180, 180)], "https://brand.example/": [200, "text/html", home] } as Record<string, [number, string, string | Uint8Array]>;
    expect(await websiteLogo(ctx(routes), "https://brand.example/")).toBeNull();
    routes["https://brand.example/robots.txt"] = [404, "text/plain", ""];
    routes["https://brand.example/apple.png"] = [200, "image/png", pngBytes(57, 57)];
    expect(await websiteLogo(ctx(routes), "https://brand.example/")).toBeNull();
    routes["https://brand.example/apple.png"] = [200, "image/png", pngBytes(180, 180)];
    expect(await websiteLogo(ctx(routes), "https://brand.example/", () => false)).toBeNull();
    expect(await websiteLogo(ctx(routes), "http://brand.example/")).toBeNull();
  });
});

describe("HostRateLimiter", () => {
  it("spaces requests to the same host", async () => {
    let t = 0;
    const waits: number[] = [];
    const lim = new HostRateLimiter(() => 1000, async (ms) => { waits.push(ms); t += ms; }, () => t);
    await lim.wait("https://a.example/1");
    await lim.wait("https://b.example/1");
    t += 200;
    await lim.wait("https://a.example/2");
    expect(waits).toEqual([800]);
  });
});

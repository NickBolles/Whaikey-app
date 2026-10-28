import { describe, expect, it } from "vitest";
import {
  commonsLogo,
  commonsSearchLogo,
  foldProducers,
  hostMatchesBrand,
  HostRateLimiter,
  isPhotoMime,
  commonsContextMatches,
  isParentGroupHost,
  jpegLooksLikeLogo,
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
    expect(robotsAllows("User-agent: *\nDisallow: /*\n", "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /*.png$\n", "/icon.png")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /*.png$\n", "/icon.png?v=2")).toBe(true);
  });
  it("keeps every user agent of a group (a later agent line doesn't drop our match)", () => {
    expect(robotsAllows("User-agent: CaskfolkLogoBot\nUser-agent: OtherBot\nDisallow: /\n", "/")).toBe(false);
    expect(robotsAllows("User-agent: OtherBot\nUser-agent: *\nDisallow: /x\n\nUser-agent: Third\nAllow: /\n", "/x")).toBe(false);
    expect(robotsAllows("User-agent: CaskfolkLogoBot\nDisallow: /a\nUser-agent: Other\nDisallow: /b\n", "/b")).toBe(true);
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
  it("checks a cross-origin icon against its own origin's robots.txt", async () => {
    const cdnHome = '<html><head><link rel="apple-touch-icon" href="https://cdn.example/apple.png"></head><body>Old Elk</body></html>';
    const routes = {
      "https://brand.example/robots.txt": [200, "text/plain", "User-agent: *\nAllow: /"],
      "https://cdn.example/robots.txt": [200, "text/plain", "User-agent: *\nDisallow: /"],
      "https://cdn.example/apple.png": [200, "image/png", pngBytes(180, 180)],
      "https://brand.example/": [200, "text/html", cdnHome],
    } as Record<string, [number, string, string | Uint8Array]>;
    expect(await websiteLogo(ctx(routes), "https://brand.example/")).toBeNull();
    routes["https://cdn.example/robots.txt"] = [404, "text/plain", ""];
    expect(await websiteLogo(ctx(routes), "https://brand.example/")).toMatchObject({ source: "website", pageUrl: "https://cdn.example/apple.png" });
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

describe("tightened matching (#136)", () => {
  it("website icons must sit on the brand's own domain", () => {
    expect(hostMatchesBrand("www.oldelk.com", "Old Elk")).toBe(true);
    expect(hostMatchesBrand("heavenhilldistillery.com", "Heaven Hill")).toBe(true);
    expect(hostMatchesBrand("www.taliskerwhisky.co.uk", "Talisker")).toBe(true);
    expect(hostMatchesBrand("www.malts.com", "Talisker")).toBe(false);
    expect(hostMatchesBrand("www.malts.com", "Clynelish")).toBe(false);
    expect(hostMatchesBrand("x.com", "Ab")).toBe(false);
  });

  it("refuses a website whose domain is not the brand's", async () => {
    const c = ctx({
      "https://www.malts.com/robots.txt": [404, "text/plain", ""],
      "https://www.malts.com/apple.png": [200, "image/png", pngBytes(180, 180)],
      "https://www.malts.com": [200, "text/html", '<html><head><link rel="apple-touch-icon" href="/apple.png"></head><body>Talisker</body></html>'],
    });
    expect(await websiteLogo(c, "https://www.malts.com", () => true, "Talisker")).toBeNull();
    expect(await websiteLogo(c, "https://www.malts.com", () => true)).not.toBeNull();
  });

  it("photos are never logos", async () => {
    expect(isPhotoMime("image/jpeg")).toBe(true);
    expect(isPhotoMime("image/png")).toBe(false);
    const info = (title: string, mime: string) =>
      JSON.stringify({ query: { pages: { "1": { title, imageinfo: [{ mime, thumburl: "https://upload.wikimedia.org/t.png", descriptionurl: "https://commons.wikimedia.org/wiki/F", extmetadata: { LicenseShortName: { value: "PD-textlogo" } } }] } } } });
    const c = ctx({
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=256&titles=File%3AArdbeg": [200, "application/json", info("File:Ardbeg bottle detail.jpg", "image/jpeg")],
      "https://upload.wikimedia.org/": [200, "image/png", pngBytes(256, 90)],
    });
    expect(await commonsLogo(c, "Ardbeg bottle detail.jpg")).toBeNull();
  });

  it("a Commons search hit must be categorised as a drinks producer's mark", async () => {
    const info = (cats: string) =>
      JSON.stringify({ query: { pages: { "1": { title: "File:Jura-Logo.svg", imageinfo: [{ mime: "image/svg+xml", thumburl: "https://upload.wikimedia.org/t.png", descriptionurl: "https://commons.wikimedia.org/wiki/F", extmetadata: { LicenseShortName: { value: "PD-textlogo" }, Categories: { value: cats } } }] } } } });
    const search = JSON.stringify({ query: { search: [{ title: "File:Jura-Logo.svg" }] } });
    const canton = ctx({
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search": [200, "application/json", search],
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo": [200, "application/json", info("Canton of Jura|Logos of Swiss cantons")],
      "https://upload.wikimedia.org/": [200, "image/png", pngBytes(256, 90)],
    });
    expect(await commonsSearchLogo(canton, "Jura")).toBeNull();
    const whisky = ctx({
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search": [200, "application/json", search],
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo": [200, "application/json", info("Isle of Jura distillery|Whisky logos")],
      "https://upload.wikimedia.org/": [200, "image/png", pngBytes(256, 90)],
    });
    expect(await commonsSearchLogo(whisky, "Jura")).not.toBeNull();
  });
});

/** A JPEG SOF0 header of the given size, padded to `bytes` (bytes/pixel drives the photo check). */
function jpegBytes(w: number, h: number, bytes = 64): Uint8Array {
  const b = new Uint8Array(Math.max(bytes, 20));
  b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3]);
  return b;
}

const commonsInfo = (title: string, mime: string, cats: string, size: { w: number; h: number; bytes: number } | null = null) =>
  JSON.stringify({
    query: {
      pages: {
        "1": {
          title,
          imageinfo: [{
            mime,
            ...(size ? { width: size.w, height: size.h, size: size.bytes } : {}),
            thumburl: "https://upload.wikimedia.org/t",
            descriptionurl: "https://commons.wikimedia.org/wiki/F",
            extmetadata: { LicenseShortName: { value: "PD-textlogo" }, Categories: { value: cats } },
          }],
        },
      },
    },
  });

describe("loosened matching (#139): lost logos come back", () => {
  it("domain: brand-name token prefixes and aliases (proper-no-twelve, eden-mill, whistlepig, highland-park)", () => {
    expect(hostMatchesBrand("www.properwhiskey.com", "Proper No. Twelve")).toBe(true);
    expect(hostMatchesBrand("www.edenmill.com", "Eden Mill St Andrews")).toBe(true);
    expect(hostMatchesBrand("www.whistlepigwhiskey.com", "WhistlePig")).toBe(true);
    expect(hostMatchesBrand("www.highlandparkwhisky.com", "Highland Park Distillery")).toBe(true);
    expect(hostMatchesBrand("www.glenels.de", "Elsburn", ["Glen Els"])).toBe(true);
    // A generic first word alone is not the brand ("highland" ↛ Highland Park).
    expect(hostMatchesBrand("www.highlandspring.com", "Highland Park")).toBe(false);
    // The prefix must START the domain, not sit inside another word.
    expect(hostMatchesBrand("www.improperbrands.com", "Proper No. Twelve")).toBe(false);
  });

  it("domain: parent-company sites stay refused even via Wikidata P856 (bookers, ardnamurchan, mars-tsunuki, saburomaru, croithli)", () => {
    expect(isParentGroupHost("www.beamdistilling.com")).toBe(true);
    expect(hostMatchesBrand("www.beamdistilling.com", "Booker's")).toBe(false);
    expect(hostMatchesBrand("www.adelphidistillery.com", "Ardnamurchan")).toBe(false);
    expect(hostMatchesBrand("www.hombo.co.jp", "Mars Tsunuki")).toBe(false);
    expect(hostMatchesBrand("www.wakatsuru.co.jp", "Saburomaru")).toBe(false);
    expect(hostMatchesBrand("thecrollydistillery.com", "Croithlí")).toBe(false);
    expect(hostMatchesBrand("www.malts.com", "Talisker")).toBe(false);
  });

  it("JPEG: allowed when named a logo and flat; photos still refused", () => {
    expect(jpegLooksLikeLogo("https://cdn.example/63e4_WP_%20Logo_256x256.jpg", 28_081, 256, 256)).toBe(true); // WhistlePig
    expect(jpegLooksLikeLogo("File:Glen-Els-Logo.jpg", 39_013, 392, 218, { maxSide: 2000 })).toBe(true); // Elsburn
    expect(jpegLooksLikeLogo("https://cdn.example/hero.jpg", 9_000, 256, 256)).toBe(false); // not named a logo
    expect(jpegLooksLikeLogo("https://cdn.example/logo-bottle.jpg", 9_000, 256, 256)).toBe(false); // a bottle shot
    expect(jpegLooksLikeLogo("https://cdn.example/logo.jpg", 256 * 256 * 2, 256, 256)).toBe(false); // compresses like a photo
    // Highland Park's Commons hit is a 3122px LA-neighbourhood graphic: too big a frame.
    expect(jpegLooksLikeLogo("File:Highland Park Logo.jpg", 945_493, 3122, 3122, { maxSide: 2000 })).toBe(false);
  });

  it("websiteLogo keeps WhistlePig's logo JPEG apple-touch-icon but not a photo JPEG", async () => {
    const html = (href: string) => `<html><head><link rel="apple-touch-icon" href="${href}"></head><body>WhistlePig</body></html>`;
    const logo = ctx({
      "https://www.whistlepigwhiskey.com/robots.txt": [404, "text/plain", ""],
      "https://www.whistlepigwhiskey.com/WP_%20Logo_256x256.jpg": [200, "image/jpeg", jpegBytes(256, 256, 28_000)],
      "https://www.whistlepigwhiskey.com": [200, "text/html", html("/WP_%20Logo_256x256.jpg")],
    });
    const got = await websiteLogo(logo, "https://www.whistlepigwhiskey.com", () => true, "WhistlePig");
    expect(got?.contentType).toBe("image/jpeg");
    const photo = ctx({
      "https://www.whistlepigwhiskey.com/robots.txt": [404, "text/plain", ""],
      "https://www.whistlepigwhiskey.com/barn.jpg": [200, "image/jpeg", jpegBytes(256, 256, 120_000)],
      "https://www.whistlepigwhiskey.com": [200, "text/html", html("/barn.jpg")],
    });
    expect(await websiteLogo(photo, "https://www.whistlepigwhiskey.com", () => true, "WhistlePig")).toBeNull();
  });

  it("websiteLogo takes Proper No. Twelve's icon from properwhiskey.com", async () => {
    const c = ctx({
      "https://www.properwhiskey.com/robots.txt": [404, "text/plain", ""],
      "https://www.properwhiskey.com/webclip.png": [200, "image/png", pngBytes(256, 256)],
      "https://www.properwhiskey.com": [200, "text/html", '<html><head><link rel="apple-touch-icon" href="/webclip.png"></head><body>Proper No. Twelve</body></html>'],
    });
    expect(await websiteLogo(c, "https://www.properwhiskey.com", () => true, "Proper No. Twelve")).not.toBeNull();
  });

  it("commonsLogo keeps Elsburn's Wikidata Glen-Els-Logo.jpg", async () => {
    const c = ctx({
      "https://commons.wikimedia.org/w/api.php": [200, "application/json", commonsInfo("File:Glen-Els-Logo.jpg", "image/jpeg", "Logos of companies|Simple text logos", { w: 392, h: 218, bytes: 39_013 })],
      "https://upload.wikimedia.org/": [200, "image/jpeg", jpegBytes(256, 142, 20_000)],
    });
    const got = await commonsLogo(c, "Glen-Els-Logo.jpg");
    expect(got?.contentType).toBe("image/jpeg");
  });

  it("Commons context: brand-named and country company-logo categories (suntory, ballantines)", () => {
    expect(commonsContextMatches("With trademark|PD textlogo|SVG logos of Suntory|Cyan text logos", "", "Suntory")).toBe(true);
    expect(commonsContextMatches("Logos of companies of Scotland|With trademark|PD textlogo|SVG text logos", "Ballantine's logo", "Ballantine's", "Scotland")).toBe(true);
    expect(commonsContextMatches("Logos of companies of Scotland|With trademark", "", "Ballantine's", "Japan")).toBe(false);
  });

  it("Commons context: right-to-drop look-alikes stay refused (hibiki anime agency, cambus, highland park LA)", () => {
    expect(commonsContextMatches("Text logos|With trademark|Bushiroad Group|PD textlogo|Logos of talent agencies", "ブシロードの声優プロダクション、響のロゴ", "Hibiki", "Japan")).toBe(false);
    expect(commonsContextMatches("Text logos|With trademark|PD textlogo|Cambus (Iowa)", "This is the logo for Cambus.", "Cambus", "UK")).toBe(false);
    expect(commonsContextMatches("Highland Park, Los Angeles|Self-published work", "Happening In Highland Park", "Highland Park", "UK")).toBe(false);
  });

  it("commonsSearchLogo finds Suntory's SVG logo via its brand category", async () => {
    const c = ctx({
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search": [200, "application/json", JSON.stringify({ query: { search: [{ title: "File:SUNTORY logo.svg" }] } })],
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo": [200, "application/json", commonsInfo("File:SUNTORY logo.svg", "image/svg+xml", "With trademark|PD textlogo|SVG logos of Suntory")],
      "https://upload.wikimedia.org/": [200, "image/png", pngBytes(256, 38)],
    });
    expect(await commonsSearchLogo(c, "Suntory", "Japan")).not.toBeNull();
  });

  it("commonsSearchLogo refuses the Hibiki anime-agency logo", async () => {
    const c = ctx({
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search": [200, "application/json", JSON.stringify({ query: { search: [{ title: "File:Hibiki Logo.png" }] } })],
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo": [200, "application/json", commonsInfo("File:Hibiki Logo.png", "image/png", "Text logos|With trademark|Bushiroad Group|PD textlogo|Logos of talent agencies")],
      "https://upload.wikimedia.org/": [200, "image/png", pngBytes(256, 118)],
    });
    expect(await commonsSearchLogo(c, "Hibiki", "Japan")).toBeNull();
  });

  it("commonsSearchLogo refuses the Highland Park (Los Angeles) JPEG", async () => {
    const c = ctx({
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search": [200, "application/json", JSON.stringify({ query: { search: [{ title: "File:Highland Park Logo.jpg" }] } })],
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo": [200, "application/json", commonsInfo("File:Highland Park Logo.jpg", "image/jpeg", "Highland Park, Los Angeles|Self-published work", { w: 3122, h: 3122, bytes: 945_493 })],
      "https://upload.wikimedia.org/": [200, "image/jpeg", jpegBytes(256, 256, 9_000)],
    });
    expect(await commonsSearchLogo(c, "Highland Park", "UK")).toBeNull();
  });
});

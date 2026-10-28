import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { DB } from "@/db";
import { createTestBottle, setupTestDb } from "@/test/helpers";
import { searchBottles } from "@/lib/search";
import { coverageMarkdown, pageMentionsBrand, planBrands, rejectBrandLogos, runLogoBackfill } from "./backfill";
import { HostRateLimiter, type WikidataProducer } from "./fetch";
import { pngBytes, stubFetch } from "./test-utils";
import { GET } from "@/app/api/brand-logo/[key]/route";

const noWait = new HostRateLimiter(() => 0, async () => {});

const producers: WikidataProducer[] = [
  { id: "Q911587", label: "Glenfiddich Distillery", aliases: [], countries: ["United Kingdom"], instanceOf: ["Q10373548"], logoFiles: ["Glenfiddich logo.svg"], website: null },
  { id: "Q280", label: "Lagavulin Distillery", aliases: [], countries: ["United Kingdom"], instanceOf: ["Q10373548"], logoFiles: ["Lagavulin wordmark.svg"], website: null },
  { id: "Q7", label: "Nobody Distillery", aliases: [], countries: [], instanceOf: ["Q10373548"], logoFiles: [], website: null },
];

const commonsInfo = (license: string) =>
  JSON.stringify({ query: { pages: { "1": { imageinfo: [{ thumburl: "https://upload.wikimedia.org/thumb/x.png", descriptionurl: "https://commons.wikimedia.org/wiki/File:X", extmetadata: { LicenseShortName: { value: license }, Artist: { value: "Someone" } } }] } } } });

function routes(): typeof fetch {
  return stubFetch({
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=256&titles=File%3AGlenfiddich": [200, "application/json", commonsInfo("PD-textlogo")],
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|mime|size|extmetadata&iiurlwidth=256&titles=File%3ALagavulin": [200, "application/json", commonsInfo("CC BY-SA 4.0")],
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search": [200, "application/json", JSON.stringify({ query: { search: [] } })],
    "https://upload.wikimedia.org/": [200, "image/png", pngBytes(256, 90)],
    "https://www.oldelk.com/robots.txt": [404, "text/plain", ""],
    "https://www.oldelk.com/apple.png": [200, "image/png", pngBytes(180, 180)],
    "https://www.oldelk.com": [200, "text/html", '<html><head><link rel="apple-touch-icon" href="/apple.png"></head><body>Old Elk Bourbon</body></html>'],
  });
}

describe("logo backfill", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
    await db.insert(schema.distilleries).values({ id: "glenfiddich", name: "Glenfiddich", country: "Scotland" });
    await createTestBottle(db, { id: "b-gf12", name: "Glenfiddich 12 Year", category: "scotch-single-malt", distilleryId: "glenfiddich" });
    await createTestBottle(db, { id: "b-gf18", name: "Glenfiddich 18 Year Old", category: "scotch-single-malt" });
    await createTestBottle(db, { id: "b-lag16", name: "Lagavulin 16", category: "scotch-single-malt" });
    await createTestBottle(db, { id: "b-elk", name: "Old Elk Wheated Bourbon", category: "bourbon" });
    await createTestBottle(db, { id: "b-none", name: "Mystery Cask 7", category: "world" });
  });

  it("plans brands from distilleries, seeds and Wikidata", () => {
    const plans = planBrands([{ id: "glenfiddich", name: "Glenfiddich", country: "Scotland" }], [{ name: "Old Elk", website: "https://www.oldelk.com" }], producers);
    const gf = plans.find((p) => p.key === "glenfiddich");
    expect(gf).toMatchObject({ distilleryId: "glenfiddich", wikidataId: "Q911587", logoFiles: ["Glenfiddich logo.svg"] });
    expect(plans.find((p) => p.key === "old-elk")?.website).toBe("https://www.oldelk.com");
  });

  it("never enriches a curated/distillery plan with a producer that failed identity checks", () => {
    // Same name, wrong country: pickWikidataEntity rejects it, so the
    // distillery plan must not inherit its website or logo files later.
    const wrong: WikidataProducer = { id: "Q999", label: "Glenfiddich", aliases: [], countries: ["Japan"], instanceOf: ["Q10373548"], logoFiles: ["Other logo.svg"], website: "https://other.example" };
    const plans = planBrands([{ id: "glenfiddich", name: "Glenfiddich", country: "Scotland" }], [], [wrong]);
    expect(plans.find((p) => p.key === "glenfiddich")).toMatchObject({ distilleryId: "glenfiddich", wikidataId: null, website: null, logoFiles: [] });
  });

  it("files bottles, stores license-gated logos, and is idempotent", async () => {
    const opts = { apply: true, producers, seeds: [{ name: "Old Elk", country: "USA", website: "https://www.oldelk.com" }], limiter: noWait, now: new Date("2026-10-28T00:00:00Z") };
    const first = await runLogoBackfill(db, { ...opts, fetchImpl: routes() });
    expect(first.bottlesReassigned).toBe(4);
    expect(first.found).toEqual({ wikidata: 2, website: 1 });

    const keys = Object.fromEntries((await db.select({ id: schema.bottles.id, k: schema.bottles.brandKey }).from(schema.bottles)).map((r) => [r.id, r.k]));
    expect(keys).toEqual({ "b-gf12": "glenfiddich", "b-gf18": "glenfiddich", "b-lag16": "lagavulin", "b-elk": "old-elk", "b-none": null });

    const [lag] = await db.select().from(schema.brandLogos).where(eq(schema.brandLogos.key, "lagavulin"));
    expect(lag).toMatchObject({ status: "ok", logoSource: "wikidata", license: "CC BY-SA 4.0", attributionRequired: true, width: 256, height: 90 });
    const [elk] = await db.select().from(schema.brandLogos).where(eq(schema.brandLogos.key, "old-elk"));
    expect(elk).toMatchObject({ status: "ok", logoSource: "website", license: "nominative-use", attribution: "oldelk.com" });

    expect(first.coverage).toMatchObject({ distilleries: 1, distilleriesWithLogo: 1, bottles: 5, bottlesWithBrand: 4, bottlesWithAnyLogo: 4, bottlesWithCardLogo: 3 });
    expect(first.coverage?.logos.every((l) => l.key && l.source && l.license)).toBe(true);
    expect(first.coverage?.logos.length).toBeGreaterThanOrEqual(2);
    expect(coverageMarkdown(first)).toContain("| bottles (cards) | 3 | 5 | 60.0% |");

    // Second run: nothing re-filed, nothing re-fetched.
    const fetch2 = routes();
    const second = await runLogoBackfill(db, { ...opts, fetchImpl: fetch2, now: new Date("2026-10-29T00:00:00Z") });
    expect(second.bottlesReassigned).toBe(0);
    expect(second.checked).toBe(0);
    expect(fetch2).not.toHaveBeenCalled();

    // Cards only carry marks that need no credit; CC BY-SA Lagavulin stays off cards.
    const results = await searchBottles(db, "");
    const logoOf = (id: string) => results.find((r) => r.id === id)?.brandLogo ?? null;
    expect(logoOf("b-gf18")).toBe("glenfiddich");
    expect(logoOf("b-elk")).toBe("old-elk");
    expect(logoOf("b-lag16")).toBeNull();
    expect(logoOf("b-none")).toBeNull();

    // The route serves the stored bytes from our origin with a locked-down CSP.
    const res = await GET(new Request("http://x/api/brand-logo/glenfiddich"), { params: Promise.resolve({ key: "glenfiddich" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cache-control")).toContain("s-maxage");
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect((await GET(new Request("http://x"), { params: Promise.resolve({ key: "nope" }) })).status).toBe(404);
    expect((await GET(new Request("http://x"), { params: Promise.resolve({ key: "../etc" }) })).status).toBe(404);
  });

  it("keeps an existing mark when a forced re-check can't reach the source, and dry runs write nothing", async () => {
    const opts = { producers, seeds: [], limiter: noWait };
    const dry = await runLogoBackfill(db, { ...opts, fetchImpl: routes() });
    expect(dry.coverage).toBeNull();
    expect(await db.select().from(schema.brandLogos)).toHaveLength(0);
    expect((await db.select({ k: schema.bottles.brandKey }).from(schema.bottles)).every((r) => r.k === null)).toBe(true);

    await runLogoBackfill(db, { ...opts, apply: true, fetchImpl: routes() });
    await runLogoBackfill(db, { ...opts, apply: true, force: true, fetchImpl: stubFetch({}) });
    const [gf] = await db.select().from(schema.brandLogos).where(eq(schema.brandLogos.key, "glenfiddich"));
    expect(gf?.status).toBe("ok");
    expect(gf?.logoData).toBeTruthy();

    // A takedown is final: a forced re-check must not resurrect it.
    await db.update(schema.brandLogos).set({ status: "rejected" }).where(eq(schema.brandLogos.key, "glenfiddich"));
    await runLogoBackfill(db, { ...opts, apply: true, force: true, fetchImpl: routes() });
    const [taken] = await db.select().from(schema.brandLogos).where(eq(schema.brandLogos.key, "glenfiddich"));
    expect(taken?.status).toBe("rejected");
  });

  it("rejects marks for good: bytes cleared, 404 from the route, never re-fetched (#136)", async () => {
    const opts = { producers, seeds: [{ name: "Old Elk", country: "USA", website: "https://www.oldelk.com" }], limiter: noWait };
    await runLogoBackfill(db, { ...opts, apply: true, fetchImpl: routes() });
    const dry = await rejectBrandLogos(db, ["glenfiddich"]);
    expect(dry.rejected).toEqual(["glenfiddich"]);
    expect((await db.select().from(schema.brandLogos).where(eq(schema.brandLogos.key, "glenfiddich")))[0]?.status).toBe("ok");

    const res = await rejectBrandLogos(db, [" Glenfiddich", "glenfiddich", "never-seen"], { apply: true });
    expect(res).toEqual({ rejected: ["glenfiddich", "never-seen"], created: ["never-seen"] });
    const [gf] = await db.select().from(schema.brandLogos).where(eq(schema.brandLogos.key, "glenfiddich"));
    expect(gf).toMatchObject({ status: "rejected", logoData: null, logoSource: null, license: null });
    expect((await GET(new Request("http://x"), { params: Promise.resolve({ key: "glenfiddich" }) })).status).toBe(404);

    const fetch2 = routes();
    await runLogoBackfill(db, { ...opts, apply: true, force: true, clearMissing: true, fetchImpl: fetch2 });
    expect((await db.select().from(schema.brandLogos).where(eq(schema.brandLogos.key, "glenfiddich")))[0]?.status).toBe("rejected");
    await expect(rejectBrandLogos(db, ["../etc"], { apply: true })).rejects.toThrow(/invalid brand key/);
  });

  it("refuses a website icon shared by two brands (group portfolio sites, #136)", async () => {
    await createTestBottle(db, { id: "b-elk2", name: "Old Elkhorn Rye", category: "rye" });
    const shared = stubFetch({
      "https://commons.wikimedia.org/": [200, "application/json", JSON.stringify({ query: { search: [] } })],
      "https://www.oldelk.com/robots.txt": [404, "text/plain", ""],
      "https://www.oldelkhorn.com/robots.txt": [404, "text/plain", ""],
      "https://www.oldelk.com/apple.png": [200, "image/png", pngBytes(180, 180)],
      "https://www.oldelkhorn.com/apple.png": [200, "image/png", pngBytes(180, 180)],
      "https://www.oldelk.com": [200, "text/html", '<html><head><link rel="apple-touch-icon" href="/apple.png"></head><body>Old Elk</body></html>'],
      "https://www.oldelkhorn.com": [200, "text/html", '<html><head><link rel="apple-touch-icon" href="/apple.png"></head><body>Old Elkhorn</body></html>'],
    });
    const seeds = [
      { name: "Old Elk", website: "https://www.oldelk.com" },
      { name: "Old Elkhorn", website: "https://www.oldelkhorn.com" },
    ];
    const r = await runLogoBackfill(db, { apply: true, producers: [], seeds, limiter: noWait, fetchImpl: shared });
    expect(r.found.website ?? 0).toBe(0);
    const rows = await db.select().from(schema.brandLogos);
    expect(rows.filter((x) => x.key.startsWith("old-elk")).every((x) => x.status === "none")).toBe(true);

    // A stored icon that a scheduled re-check finds shared comes down without --clear-missing.
    await db.update(schema.brandLogos).set({ status: "ok", logoSource: "website", logoData: "aGk=" }).where(eq(schema.brandLogos.key, "old-elk"));
    await runLogoBackfill(db, { apply: true, force: true, producers: [], seeds, limiter: noWait, fetchImpl: shared });
    expect((await db.select().from(schema.brandLogos).where(eq(schema.brandLogos.key, "old-elk")))[0]).toMatchObject({ status: "none", logoData: null });
  });

  it("clearMissing keeps a stored mark when the lookup hit a network error", async () => {
    const opts = { producers, seeds: [], limiter: noWait };
    await runLogoBackfill(db, { ...opts, apply: true, fetchImpl: routes() });
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await runLogoBackfill(db, { ...opts, apply: true, force: true, clearMissing: true, fetchImpl: down });
    const [gf] = await db.select().from(schema.brandLogos).where(eq(schema.brandLogos.key, "glenfiddich"));
    expect(gf?.status).toBe("ok");
  });

  it("clearMissing takes down a stored mark the tightened rules now refuse", async () => {
    const opts = { producers, seeds: [], limiter: noWait };
    await runLogoBackfill(db, { ...opts, apply: true, fetchImpl: routes() });
    const none = stubFetch({
      "https://commons.wikimedia.org/": [200, "application/json", JSON.stringify({ query: { pages: { "1": { missing: "" } }, search: [] } })],
    });
    await runLogoBackfill(db, { ...opts, apply: true, force: true, clearMissing: true, fetchImpl: none });
    const [gf] = await db.select().from(schema.brandLogos).where(eq(schema.brandLogos.key, "glenfiddich"));
    expect(gf).toMatchObject({ status: "none", logoData: null });
  });

  it("pageMentionsBrand guards against parked or wrong domains", () => {
    expect(pageMentionsBrand("<title>Old Elk Bourbon</title>", "Old Elk")).toBe(true);
    expect(pageMentionsBrand("<title>OLDELK</title>", "Old Elk")).toBe(true);
    expect(pageMentionsBrand("<title>This domain is for sale</title>", "Old Elk")).toBe(false);
  });
});

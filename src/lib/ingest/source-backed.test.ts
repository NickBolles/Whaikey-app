import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle as createBaseTestBottle, setupTestDb } from "@/test/helpers";
import {
  ingestSourceManifest,
  isPublicIpAddress,
  parseSourceDocument,
  resolvePublicAddresses,
  validatePublicSourceUrl,
  type CatalogSourceManifest,
} from "./source-backed";

async function createTestBottle(
  db: DB,
  overrides: Partial<schema.NewBottle> = {},
): Promise<schema.Bottle> {
  return createBaseTestBottle(db, { name: "Example Reserve 10 Year", ...overrides });
}

const OFFICIAL_SOURCE = {
  id: "example-distillery",
  name: "Example Distillery",
  kind: "official" as const,
  baseUrl: "https://www.example-distillery.com",
  fetchPolicy: "structured" as const,
  mediaPolicy: "display_remote" as const,
};

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

const PRODUCT_HTML = `<!doctype html>
<html><head>
  <title>Example Reserve 10 Year | Example Distillery</title>
  <meta property="og:title" content="Example Reserve 10 Year" />
  <meta property="og:image" content="https://www.example-distillery.com/images/reserve-10.png" />
  <link rel="canonical" href="https://www.example-distillery.com/products/reserve-10" />
  <script type="application/ld+json">{
    "@context":"https://schema.org",
    "@type":"Product",
    "name":"Example Reserve 10 Year",
    "description":"A ten year straight bourbon matured in new charred oak.",
    "image":"https://www.example-distillery.com/images/reserve-10.png",
    "brand":{"@type":"Brand","name":"Example Distillery"},
    "gtin12":"080244002145",
    "additionalProperty":[
      {"@type":"PropertyValue","name":"ABV","value":"45%"},
      {"@type":"PropertyValue","name":"Age","value":"10 years"}
    ]
  }</script>
</head><body></body></html>`;

describe("source-backed document extraction", () => {
  it("extracts bounded facts and media from JSON-LD and OpenGraph without copying review prose", () => {
    const parsed = parseSourceDocument({
      url: "https://www.example-distillery.com/products/reserve-10",
      contentType: "text/html",
      body: PRODUCT_HTML,
      source: OFFICIAL_SOURCE,
      resourceType: "official_product",
      mediaKind: "bottle",
    });

    expect(parsed.title).toBe("Example Reserve 10 Year");
    expect(parsed.canonicalUrl).toBe("https://www.example-distillery.com/products/reserve-10");
    expect(parsed.claims).toEqual(expect.arrayContaining([
      { field: "brand", value: "Example Distillery" },
      { field: "gtin", value: "080244002145" },
      { field: "abv", value: 45 },
      { field: "ageYears", value: 10 },
    ]));
    expect(parsed.media).toEqual([
      expect.objectContaining({
        kind: "bottle",
        url: "https://www.example-distillery.com/images/reserve-10.png",
        rights: "display_remote",
      }),
    ]);
  });

  it("extracts canonical facts only from the page's primary product and rejects plaintext media", () => {
    const parsed = parseSourceDocument({
      url: "https://www.example-distillery.com/products/primary-reserve",
      contentType: "text/html",
      body: `<html><head>
        <title>Primary Reserve | Example Distillery</title>
        <meta property="og:title" content="Primary Reserve" />
        <script type="application/ld+json">[
          {"@type":"Product","name":"Related Reserve","image":"https://www.example-distillery.com/related.png","additionalProperty":[{"@type":"PropertyValue","name":"ABV","value":"60%"},{"@type":"PropertyValue","name":"Age","value":"18 years"}]},
          {"@type":"Product","name":"Primary Reserve","image":"http://www.example-distillery.com/primary.png","additionalProperty":[{"@type":"PropertyValue","name":"ABV","value":"45%"},{"@type":"PropertyValue","name":"Age","value":"10 years"}]}
        ]</script>
      </head></html>`,
      source: OFFICIAL_SOURCE,
      resourceType: "official_product",
      mediaKind: "bottle",
    });

    expect(parsed.claims).toEqual(expect.arrayContaining([
      { field: "name", value: "Primary Reserve" },
      { field: "abv", value: 45 },
      { field: "ageYears", value: 10 },
    ]));
    expect(parsed.claims).not.toEqual(expect.arrayContaining([
      { field: "abv", value: 60 },
      { field: "ageYears", value: 18 },
    ]));
    expect(parsed.media).toEqual([]);
  });

  it("does not match a soft-404 or unrelated product page", () => {
    const parsed = parseSourceDocument({
      url: "https://www.example-distillery.com/products/expected-reserve",
      contentType: "text/html",
      body: `<html><head>
        <title>Page not found</title>
        <meta property="og:image" content="https://www.example-distillery.com/images/unrelated.png" />
        <script type="application/ld+json">{"@type":"Product","name":"Completely Different Whiskey","image":"https://www.example-distillery.com/images/unrelated.png","additionalProperty":[{"@type":"PropertyValue","name":"ABV","value":"60%"}]}</script>
      </head></html>`,
      source: OFFICIAL_SOURCE,
      resourceType: "official_product",
      mediaKind: "bottle",
      expectedBottleName: "Expected Reserve",
    });

    expect(parsed.primaryProductMatched).toBe(false);
    expect(parsed.claims).toEqual([]);
    expect(parsed.media).toEqual([]);
  });

  it("normalizes only whole-year age units", () => {
    const parseAge = (property: string) => parseSourceDocument({
      url: "https://www.example-distillery.com/products/reserve-10",
      contentType: "text/html",
      body: PRODUCT_HTML.replace('{"@type":"PropertyValue","name":"Age","value":"10 years"}', property),
      source: OFFICIAL_SOURCE,
      resourceType: "official_product",
    }).claims.find((claim) => claim.field === "ageYears")?.value;

    expect(parseAge('{"@type":"PropertyValue","name":"Age","value":"18 months"}')).toBeUndefined();
    expect(parseAge('{"@type":"PropertyValue","name":"Age","value":24,"unitText":"months"}')).toBe(2);
    expect(parseAge('{"@type":"PropertyValue","name":"Age","value":"12 years"}')).toBe(12);
  });

  it("extracts a structured review score but never stores the article body", () => {
    const parsed = parseSourceDocument({
      url: "https://reviews.example/review/example-reserve",
      contentType: "text/html",
      body: `<html><head><meta property="og:title" content="Example Reserve Review"><script type="application/ld+json">{
        "@type":"Review",
        "itemReviewed":{"@type":"Product","name":"Example Reserve","description":"Copyrighted excerpt hidden in Product.description."},
        "reviewRating":{"ratingValue":"91","bestRating":"100"},
        "reviewBody":"A very long copyrighted review that must not be retained."
      }</script></head><body>Full article body</body></html>`,
      source: { ...OFFICIAL_SOURCE, id: "reviews", name: "Reviews Example", kind: "editorial", baseUrl: "https://reviews.example", mediaPolicy: "link_only" },
      resourceType: "review",
      mediaKind: "bottle",
      expectedBottleName: "Example Reserve",
    });

    expect(parsed.claims).toContainEqual({ field: "reviewScore", value: { score: "91", scale: "100" } });
    expect(JSON.stringify(parsed)).not.toContain("copyrighted review");
    expect(JSON.stringify(parsed)).not.toContain("Copyrighted excerpt");
    expect(JSON.stringify(parsed)).not.toContain("Full article body");
  });

  it("extracts review scores only for the selected bottle", () => {
    const parsed = parseSourceDocument({
      url: "https://reviews.example/review/expected-reserve",
      contentType: "text/html",
      body: `<html><head><meta property="og:title" content="Expected Reserve Review"><script type="application/ld+json">[
        {"@type":"Review","itemReviewed":{"@type":"Product","name":"Expected Reserve Cask Strength"},"reviewRating":{"ratingValue":"100","bestRating":"100"}},
        {"@type":"Review","itemReviewed":{"@type":"Product","name":"Expected Reserve"},"reviewRating":{"ratingValue":"90","bestRating":"100"}}
      ]</script></head></html>`,
      source: { ...OFFICIAL_SOURCE, id: "reviews", name: "Reviews Example", kind: "editorial", baseUrl: "https://reviews.example", mediaPolicy: "link_only" },
      resourceType: "review",
      expectedBottleName: "Expected Reserve",
    });

    expect(parsed.claims.filter((claim) => claim.field === "reviewScore")).toEqual([
      { field: "reviewScore", value: { score: "90", scale: "100" } },
    ]);
  });

  it("extracts Product JSON from application/json responses", () => {
    const parsed = parseSourceDocument({
      url: "https://www.example-distillery.com/api/reserve",
      contentType: "application/json",
      body: JSON.stringify({ "@type": "Product", name: "API Reserve", brand: { name: "Example" }, image: "https://cdn.example-distillery.com/api.png" }),
      source: OFFICIAL_SOURCE,
      resourceType: "official_product",
      mediaKind: "bottle",
      expectedBottleName: "API Reserve",
    });

    expect(parsed.claims).toEqual(expect.arrayContaining([
      { field: "name", value: "API Reserve" },
      { field: "brand", value: "Example" },
    ]));
    expect(parsed.media[0]).toEqual(expect.objectContaining({ url: "https://cdn.example-distillery.com/api.png" }));
  });

  it("rejects local, credentialed, and cross-origin URLs", () => {
    expect(() => validatePublicSourceUrl("http://127.0.0.1/private", OFFICIAL_SOURCE)).toThrow(/HTTPS|public/i);
    expect(() => validatePublicSourceUrl("https://user:pass@www.example-distillery.com/a", OFFICIAL_SOURCE)).toThrow(/credentials/i);
    expect(() => validatePublicSourceUrl("https://attacker.example/a", OFFICIAL_SOURCE)).toThrow(/source origin/i);
    expect(() => validatePublicSourceUrl("https://[::ffff:7f00:1]/private", {
      ...OFFICIAL_SOURCE,
      baseUrl: "https://[::ffff:7f00:1]",
    })).toThrow(/public/i);
    expect(isPublicIpAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects a public-looking hostname when DNS resolves to any private address", async () => {
    await expect(resolvePublicAddresses("producer.example", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toThrow(/non-public address/i);
  });
});

describe("source-backed persistence", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("promotes from an official product page, preserves curated values, and is idempotent", async () => {
    const bottle = await createTestBottle(db, {
      id: "example-reserve-10",
      name: "Example Reserve 10",
      status: "imported",
      abv: null,
      ageYears: null,
      description: "Curated copy wins.",
      imageUrl: null,
    });
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{
        bottleId: bottle.id,
        sourceId: OFFICIAL_SOURCE.id,
        url: "https://www.example-distillery.com/products/reserve-10",
        resourceType: "official_product",
        mediaKind: "bottle",
      }],
    };
    const fetchImpl = vi.fn(async () => htmlResponse(PRODUCT_HTML)) as unknown as typeof fetch;

    const first = await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });
    const second = await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });

    expect(first).toMatchObject({ fetched: 1, resourcesWritten: 1, claimsWritten: 6, mediaWritten: 1, bottlesPromoted: 1 });
    expect(second).toMatchObject({ fetched: 1, resourcesWritten: 0, claimsWritten: 0, mediaWritten: 0, bottlesPromoted: 0 });

    const [updated] = await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id));
    expect(updated).toMatchObject({
      status: "verified",
      abv: 45,
      ageYears: 10,
      description: "Curated copy wins.",
      imageUrl: "https://www.example-distillery.com/images/reserve-10.png",
    });
    expect(await db.select().from(schema.bottleResources)).toHaveLength(1);
    expect(await db.select().from(schema.bottleClaims)).toHaveLength(6);
    expect(await db.select().from(schema.bottleMedia)).toHaveLength(1);
    expect(await db.select().from(schema.bottleVerifications)).toHaveLength(1);
  });

  it("replaces a changed page's extracted snapshot instead of retaining stale accepted claims", async () => {
    const bottle = await createTestBottle(db, { id: "changed-page", status: "imported", abv: null, ageYears: null });
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/products/reserve-10", resourceType: "official_product", mediaKind: "bottle" }],
    };
    const changedHtml = PRODUCT_HTML
      .replace('"value":"45%"', '"value":"50%"')
      .replace('"value":"10 years"', '"value":"12 years"')
      .replaceAll("https://www.example-distillery.com/images/reserve-10.png", "https://www.example-distillery.com/images/reserve-12.png");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(htmlResponse(PRODUCT_HTML))
      .mockResolvedValueOnce(htmlResponse(changedHtml)) as unknown as typeof fetch;

    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });
    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });

    const claims = await db.select().from(schema.bottleClaims);
    expect(claims).toHaveLength(6);
    expect(claims.find((claim) => claim.field === "abv")?.value).toBe(50);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      abv: 50,
      ageYears: 12,
      imageUrl: "https://www.example-distillery.com/images/reserve-12.png",
    });
    expect(await db.select().from(schema.bottleMedia)).toHaveLength(1);
  });

  it("clears source-managed canonical facts when a changed page removes them", async () => {
    const bottle = await createTestBottle(db, { id: "removed-canonical-facts", status: "imported", abv: null, ageYears: null });
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/products/reserve-10", resourceType: "official_product" }],
    };
    const withoutCanonicalFacts = PRODUCT_HTML
      .replace('      {"@type":"PropertyValue","name":"ABV","value":"45%"},\n', "")
      .replace('      {"@type":"PropertyValue","name":"Age","value":"10 years"}\n', "");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(htmlResponse(PRODUCT_HTML))
      .mockResolvedValueOnce(htmlResponse(withoutCanonicalFacts)) as unknown as typeof fetch;

    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });
    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });

    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      abv: null,
      ageYears: null,
    });
    expect((await db.select().from(schema.bottleClaims)).some((claim) => claim.field === "abv" || claim.field === "ageYears")).toBe(false);
  });

  it("serializes official resources for one bottle while allowing cross-bottle concurrency", async () => {
    const bottle = await createTestBottle(db, { id: "serialized-canonical", status: "imported", abv: null });
    const sourceA = { ...OFFICIAL_SOURCE, id: "serialize-a" };
    const sourceB = { ...OFFICIAL_SOURCE, id: "serialize-b" };
    const page = (path: string, abv: string) => PRODUCT_HTML
      .replace("https://www.example-distillery.com/products/reserve-10", `https://www.example-distillery.com/products/${path}`)
      .replace('"value":"45%"', `"value":"${abv}%"`);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const current = String(url);
      if (current.endsWith("/a")) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return htmlResponse(page("a", "45"));
      }
      return htmlResponse(page("b", "50"));
    }) as unknown as typeof fetch;

    await ingestSourceManifest(db, {
      sources: [sourceA, sourceB],
      resources: [
        { bottleId: bottle.id, sourceId: sourceA.id, url: "https://www.example-distillery.com/products/a", resourceType: "official_product" },
        { bottleId: bottle.id, sourceId: sourceB.id, url: "https://www.example-distillery.com/products/b", resourceType: "official_product" },
      ],
    }, { apply: true, fetchImpl, concurrency: 4 });

    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].abv).toBe(45);
    expect((await db.select().from(schema.bottleClaims))
      .filter((claim) => claim.field === "abv" && claim.canonicalized)
      .map((claim) => claim.value)).toEqual([45]);
  });

  it("does not reassign an existing resource URL to a different source", async () => {
    const bottle = await createTestBottle(db, { id: "resource-source-conflict", status: "imported", abv: null });
    const resourceUrl = "https://www.example-distillery.com/products/reserve-10";
    await ingestSourceManifest(db, {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: resourceUrl, resourceType: "official_product" }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch });
    const retailer = {
      ...OFFICIAL_SOURCE,
      id: "conflicting-retailer",
      name: "Conflicting retailer",
      kind: "retailer" as const,
      fetchPolicy: "link_only" as const,
    };

    const report = await ingestSourceManifest(db, {
      sources: [retailer],
      resources: [{ bottleId: bottle.id, sourceId: retailer.id, url: resourceUrl, resourceType: "retailer" }],
    }, { apply: true });

    expect(report.errors[0]?.error).toMatch(/already associated/i);
    expect((await db.select().from(schema.bottleResources))[0]).toMatchObject({ sourceId: OFFICIAL_SOURCE.id });
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].status).toBe("verified");
  });

  it("does not persist a permissive source policy change when resource processing fails", async () => {
    const bottle = await createTestBottle(db, { id: "failed-policy-change", status: "imported", abv: null });
    const officialUrl = "https://www.example-distillery.com/products/reserve-10";
    const conflictingUrl = "https://www.example-distillery.com/products/conflicting";
    const restrictedOfficial = { ...OFFICIAL_SOURCE, mediaPolicy: "review_required" as const };
    await ingestSourceManifest(db, {
      sources: [restrictedOfficial],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: officialUrl, resourceType: "official_product" }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch });
    const editorial = {
      ...OFFICIAL_SOURCE,
      id: "policy-conflict-editorial",
      name: "Policy conflict editorial",
      kind: "editorial" as const,
      fetchPolicy: "link_only" as const,
      mediaPolicy: "link_only" as const,
    };
    await ingestSourceManifest(db, {
      sources: [editorial],
      resources: [{ bottleId: bottle.id, sourceId: editorial.id, url: conflictingUrl, resourceType: "review" }],
    }, { apply: true });
    const permissive = { ...restrictedOfficial, mediaPolicy: "display_remote" as const };
    const conflictingHtml = PRODUCT_HTML.replace(
      '<link rel="canonical" href="https://www.example-distillery.com/products/reserve-10" />',
      `<link rel="canonical" href="${conflictingUrl}" />`,
    );

    const report = await ingestSourceManifest(db, {
      sources: [permissive],
      resources: [{ bottleId: bottle.id, sourceId: permissive.id, url: officialUrl, resourceType: "official_product" }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(conflictingHtml)) as typeof fetch });

    expect(report.errors[0]?.error).toMatch(/already associated/i);
    expect((await db.select().from(schema.catalogSources).where(eq(schema.catalogSources.id, OFFICIAL_SOURCE.id)))[0].mediaPolicy)
      .toBe("review_required");
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].status).toBe("verified");
  });

  it("preserves distinct official product pages from the same source", async () => {
    const bottle = await createTestBottle(db, { id: "multiple-official-pages", status: "imported", abv: null });
    const page = (path: string, abv: string) => PRODUCT_HTML
      .replace("https://www.example-distillery.com/products/reserve-10", `https://www.example-distillery.com/products/${path}`)
      .replace('"value":"45%"', `"value":"${abv}%"`);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const current = String(url);
      return htmlResponse(current.endsWith("/single-barrel") ? page("single-barrel", "50") : page("standard", "45"));
    }) as unknown as typeof fetch;

    await ingestSourceManifest(db, {
      sources: [OFFICIAL_SOURCE],
      resources: [
        { bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/products/standard", resourceType: "official_product" },
        { bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/products/single-barrel", resourceType: "official_product" },
      ],
    }, { apply: true, fetchImpl });

    expect(await db.select().from(schema.bottleResources)).toHaveLength(2);
    expect((await db.select().from(schema.bottleClaims))
      .filter((claim) => claim.field === "abv")
      .map((claim) => claim.value).sort()).toEqual([45, 50]);
    expect(await db.select().from(schema.bottleVerifications)).toHaveLength(2);
  });

  it("promotes a remaining official fallback when the owning source removes a canonical fact", async () => {
    const bottle = await createTestBottle(db, { id: "fallback-canonical-fact", status: "imported", abv: null });
    const sourceA = { ...OFFICIAL_SOURCE, id: "official-a" };
    const sourceB = { ...OFFICIAL_SOURCE, id: "official-b" };
    const resource = (sourceId: string, path: string) => ({
      bottleId: bottle.id,
      sourceId,
      url: `https://www.example-distillery.com/products/${path}`,
      resourceType: "official_product" as const,
    });
    const page = (path: string, abv: string) => PRODUCT_HTML
      .replace("https://www.example-distillery.com/products/reserve-10", `https://www.example-distillery.com/products/${path}`)
      .replace('"value":"45%"', `"value":"${abv}%"`);

    await ingestSourceManifest(db, { sources: [sourceA], resources: [resource(sourceA.id, "a")] }, {
      apply: true,
      fetchImpl: (async () => htmlResponse(page("a", "45"))) as typeof fetch,
    });
    await ingestSourceManifest(db, { sources: [sourceB], resources: [resource(sourceB.id, "b")] }, {
      apply: true,
      fetchImpl: (async () => htmlResponse(page("b", "50"))) as typeof fetch,
    });
    const pageWithoutAbv = page("a", "45")
      .replace('      {"@type":"PropertyValue","name":"ABV","value":"45%"},\n', "");
    await ingestSourceManifest(db, { sources: [sourceA], resources: [resource(sourceA.id, "a")] }, {
      apply: true,
      fetchImpl: (async () => htmlResponse(pageWithoutAbv)) as typeof fetch,
    });

    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].abv).toBe(50);
    expect((await db.select().from(schema.bottleClaims)).some((claim) => claim.field === "abv" && claim.value === 50 && claim.canonicalized)).toBe(true);
  });

  it("keeps one resource when a stable manifest URL publishes a new canonical URL", async () => {
    const bottle = await createTestBottle(db, { id: "canonical-move", status: "imported" });
    const requestedUrl = "https://www.example-distillery.com/products/legacy";
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: requestedUrl, resourceType: "official_product" }],
    };
    const page = (canonicalUrl: string) => PRODUCT_HTML.replace(
      "https://www.example-distillery.com/products/reserve-10",
      canonicalUrl,
    );
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(htmlResponse(page(requestedUrl)))
      .mockResolvedValueOnce(htmlResponse(page("https://www.example-distillery.com/products/current")))
      .mockResolvedValueOnce(htmlResponse(page("https://www.example-distillery.com/products/next"))) as unknown as typeof fetch;

    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });
    await db.update(schema.bottleVerifications).set({ id: "legacy-random-canonical-verification" });
    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });
    await ingestSourceManifest(db, {
      sources: [OFFICIAL_SOURCE],
      resources: [{
        ...manifest.resources[0],
        url: "https://www.example-distillery.com/products/current",
      }],
    }, { apply: true, fetchImpl });

    expect(await db.select().from(schema.bottleResources)).toEqual([
      expect.objectContaining({ url: "https://www.example-distillery.com/products/next" }),
    ]);
    expect(await db.select().from(schema.bottleVerifications)).toEqual([
      expect.objectContaining({ url: "https://www.example-distillery.com/products/next" }),
    ]);
  });

  it("keeps a curated canonical override when source facts change", async () => {
    const bottle = await createTestBottle(db, { id: "curated-override", status: "verified", abv: 42, ageYears: 8 });
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/products/reserve-10", resourceType: "official_product" }],
    };
    const changedHtml = PRODUCT_HTML.replace('"value":"45%"', '"value":"50%"').replace('"value":"10 years"', '"value":"12 years"');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(htmlResponse(PRODUCT_HTML))
      .mockResolvedValueOnce(htmlResponse(changedHtml)) as unknown as typeof fetch;

    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });
    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });

    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      abv: 42,
      ageYears: 8,
    });
  });

  it("transfers canonical facts when the owning source is reclassified", async () => {
    const bottle = await createTestBottle(db, { id: "reclassified-fallback", status: "imported", abv: null, ageYears: null });
    const sourceA = { ...OFFICIAL_SOURCE, id: "reclass-a" };
    const sourceB = { ...OFFICIAL_SOURCE, id: "reclass-b" };
    const resource = (sourceId: string, path: string) => ({
      bottleId: bottle.id,
      sourceId,
      url: `https://www.example-distillery.com/products/${path}`,
      resourceType: "official_product" as const,
    });
    const page = (path: string, abv: string, age: string) => PRODUCT_HTML
      .replace("https://www.example-distillery.com/products/reserve-10", `https://www.example-distillery.com/products/${path}`)
      .replace('"value":"45%"', `"value":"${abv}%"`)
      .replace('"value":"10 years"', `"value":"${age} years"`);

    await ingestSourceManifest(db, { sources: [sourceA], resources: [resource(sourceA.id, "a")] }, {
      apply: true,
      fetchImpl: (async () => htmlResponse(page("a", "45", "10"))) as typeof fetch,
    });
    await ingestSourceManifest(db, { sources: [sourceB], resources: [resource(sourceB.id, "b")] }, {
      apply: true,
      fetchImpl: (async () => htmlResponse(page("b", "50", "12"))) as typeof fetch,
    });
    await ingestSourceManifest(db, {
      sources: [sourceA],
      resources: [{ ...resource(sourceA.id, "a"), resourceType: "review" }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(page("a", "45", "10"))) as typeof fetch });

    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      abv: 50,
      ageYears: 12,
    });
    const fallbackClaims = (await db.select().from(schema.bottleClaims))
      .filter((claim) => (claim.field === "abv" || claim.field === "ageYears") && claim.canonicalized);
    expect(fallbackClaims.map((claim) => claim.value).sort()).toEqual([12, 50]);
  });

  it("replaces the extracted snapshot when an unchanged page is reclassified", async () => {
    const bottle = await createTestBottle(db, { id: "reclassified-page", status: "imported", abv: null, ageYears: null, imageUrl: null });
    const resource = {
      bottleId: bottle.id,
      sourceId: OFFICIAL_SOURCE.id,
      url: "https://www.example-distillery.com/products/reserve-10",
      resourceType: "official_product" as const,
      mediaKind: "bottle" as const,
    };
    const fetchImpl = vi.fn(async () => htmlResponse(PRODUCT_HTML)) as unknown as typeof fetch;
    await ingestSourceManifest(db, { sources: [OFFICIAL_SOURCE], resources: [resource] }, { apply: true, fetchImpl });
    await ingestSourceManifest(db, {
      sources: [OFFICIAL_SOURCE],
      resources: [{ ...resource, resourceType: "review" }],
    }, { apply: true, fetchImpl });

    const claims = await db.select().from(schema.bottleClaims);
    expect(claims.some((claim) => claim.field === "description")).toBe(false);
    expect(claims.every((claim) => claim.status === "corroborating")).toBe(true);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      status: "imported",
      abv: null,
      ageYears: null,
      imageUrl: null,
    });
    expect(await db.select().from(schema.bottleVerifications)).toEqual([]);
  });

  it("keeps verified status when another verification remains after source revocation", async () => {
    const bottle = await createTestBottle(db, { id: "multi-verification", status: "imported" });
    const resource = {
      bottleId: bottle.id,
      sourceId: OFFICIAL_SOURCE.id,
      url: "https://www.example-distillery.com/products/reserve-10",
      resourceType: "official_product" as const,
    };
    const fetchImpl = vi.fn(async () => htmlResponse(PRODUCT_HTML)) as unknown as typeof fetch;
    await ingestSourceManifest(db, { sources: [OFFICIAL_SOURCE], resources: [resource] }, { apply: true, fetchImpl });
    await db.insert(schema.bottleVerifications).values({
      id: "other-verification",
      bottleId: bottle.id,
      url: "https://retailer.example/product",
      label: "Other source",
      retrievedAt: new Date(),
    });
    await ingestSourceManifest(db, {
      sources: [OFFICIAL_SOURCE],
      resources: [{ ...resource, resourceType: "review" }],
    }, { apply: true, fetchImpl });

    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].status).toBe("verified");
    expect(await db.select().from(schema.bottleVerifications)).toEqual([
      expect.objectContaining({ id: "other-verification", promotedBottle: true }),
    ]);
  });

  it("transfers canonical image ownership when the owning source removes its image", async () => {
    const bottle = await createTestBottle(db, { id: "fallback-canonical-image", status: "imported", imageUrl: null });
    const sourceA = { ...OFFICIAL_SOURCE, id: "image-a" };
    const sourceB = { ...OFFICIAL_SOURCE, id: "image-b" };
    const resource = (sourceId: string, path: string) => ({
      bottleId: bottle.id,
      sourceId,
      url: `https://www.example-distillery.com/products/${path}`,
      resourceType: "official_product" as const,
      mediaKind: "bottle" as const,
    });
    const pageA = PRODUCT_HTML.replace(
      "https://www.example-distillery.com/products/reserve-10",
      "https://www.example-distillery.com/products/image-a",
    );
    const fallbackImage = "https://www.example-distillery.com/images/fallback.png";
    const pageB = PRODUCT_HTML
      .replace("https://www.example-distillery.com/products/reserve-10", "https://www.example-distillery.com/products/image-b")
      .replaceAll("https://www.example-distillery.com/images/reserve-10.png", fallbackImage);
    const pageAWithoutImage = pageA
      .replace('  <meta property="og:image" content="https://www.example-distillery.com/images/reserve-10.png" />\n', "")
      .replace('    "image":"https://www.example-distillery.com/images/reserve-10.png",\n', "");

    await ingestSourceManifest(db, { sources: [sourceA], resources: [resource(sourceA.id, "image-a")] }, {
      apply: true, fetchImpl: (async () => htmlResponse(pageA)) as typeof fetch,
    });
    await ingestSourceManifest(db, { sources: [sourceB], resources: [resource(sourceB.id, "image-b")] }, {
      apply: true, fetchImpl: (async () => htmlResponse(pageB)) as typeof fetch,
    });
    await ingestSourceManifest(db, { sources: [sourceA], resources: [resource(sourceA.id, "image-a")] }, {
      apply: true, fetchImpl: (async () => htmlResponse(pageAWithoutImage)) as typeof fetch,
    });

    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].imageUrl).toBe(fallbackImage);
    expect((await db.select().from(schema.bottleMedia)).find((media) => media.url === fallbackImage)?.canonicalized).toBe(true);
  });

  it("selects one deterministic fallback owner when multiple official sources remain", async () => {
    const bottle = await createTestBottle(db, { id: "deterministic-fallback", status: "imported", abv: null, imageUrl: null });
    const owner = { ...OFFICIAL_SOURCE, id: "fallback-owner" };
    const alpha = { ...OFFICIAL_SOURCE, id: "fallback-alpha" };
    const zulu = { ...OFFICIAL_SOURCE, id: "fallback-zulu" };
    const resource = (sourceId: string, path: string) => ({
      bottleId: bottle.id,
      sourceId,
      url: `https://www.example-distillery.com/products/${path}`,
      resourceType: "official_product" as const,
      mediaKind: "bottle" as const,
    });
    const page = (path: string, abv: string, image: string) => PRODUCT_HTML
      .replace("https://www.example-distillery.com/products/reserve-10", `https://www.example-distillery.com/products/${path}`)
      .replace('"value":"45%"', `"value":"${abv}%"`)
      .replaceAll("https://www.example-distillery.com/images/reserve-10.png", image);
    const alphaImage = "https://www.example-distillery.com/images/alpha.png";
    const zuluImage = "https://www.example-distillery.com/images/zulu.png";

    await ingestSourceManifest(db, { sources: [owner], resources: [resource(owner.id, "owner")] }, {
      apply: true, fetchImpl: (async () => htmlResponse(page("owner", "45", "https://www.example-distillery.com/images/owner.png"))) as typeof fetch,
    });
    await ingestSourceManifest(db, { sources: [alpha], resources: [resource(alpha.id, "alpha")] }, {
      apply: true, fetchImpl: (async () => htmlResponse(page("alpha", "50", alphaImage))) as typeof fetch,
    });
    await ingestSourceManifest(db, { sources: [zulu], resources: [resource(zulu.id, "zulu")] }, {
      apply: true, fetchImpl: (async () => htmlResponse(page("zulu", "55", zuluImage))) as typeof fetch,
    });
    await ingestSourceManifest(db, {
      sources: [owner],
      resources: [{ ...resource(owner.id, "owner"), resourceType: "review" }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(page("owner", "45", "https://www.example-distillery.com/images/owner.png"))) as typeof fetch });

    const updated = (await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0];
    expect(updated).toMatchObject({ abv: 50, imageUrl: alphaImage });
    expect((await db.select().from(schema.bottleClaims))
      .filter((claim) => claim.field === "abv" && claim.canonicalized)
      .map((claim) => claim.value)).toEqual([50]);
    expect((await db.select().from(schema.bottleMedia))
      .filter((media) => media.kind === "bottle" && media.canonicalized)
      .map((media) => media.url)).toEqual([alphaImage]);
  });

  it("tightens persisted media rights even when page content is unchanged", async () => {
    const bottle = await createTestBottle(db, { id: "media-policy-change", status: "imported" });
    const resource = {
      bottleId: bottle.id,
      sourceId: OFFICIAL_SOURCE.id,
      url: "https://www.example-distillery.com/products/reserve-10",
      resourceType: "official_product" as const,
      mediaKind: "bottle" as const,
    };
    const fetchImpl = vi.fn(async () => htmlResponse(PRODUCT_HTML)) as unknown as typeof fetch;
    await ingestSourceManifest(db, { sources: [OFFICIAL_SOURCE], resources: [resource] }, { apply: true, fetchImpl });
    await ingestSourceManifest(db, {
      sources: [{ ...OFFICIAL_SOURCE, mediaPolicy: "review_required" }],
      resources: [resource],
    }, { apply: true, fetchImpl });

    expect(await db.select().from(schema.bottleMedia)).toEqual([
      expect.objectContaining({ rights: "review_required" }),
    ]);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].imageUrl).toBeNull();
  });

  it("quarantines media immediately when a restrictive policy refresh cannot fetch", async () => {
    const bottle = await createTestBottle(db, { id: "media-policy-fetch-failure", status: "imported", imageUrl: null });
    const resource = {
      bottleId: bottle.id,
      sourceId: OFFICIAL_SOURCE.id,
      url: "https://www.example-distillery.com/products/reserve-10",
      resourceType: "official_product" as const,
      mediaKind: "bottle" as const,
    };
    await ingestSourceManifest(db, { sources: [OFFICIAL_SOURCE], resources: [resource] }, {
      apply: true,
      fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch,
    });
    const fallbackSource = { ...OFFICIAL_SOURCE, id: "fallback-image-source" };
    const fallbackUrl = "https://www.example-distillery.com/products/fallback-reserve";
    const fallbackImage = "https://www.example-distillery.com/images/fallback-policy.png";
    const fallbackHtml = PRODUCT_HTML
      .replace("https://www.example-distillery.com/products/reserve-10", fallbackUrl)
      .replaceAll("https://www.example-distillery.com/images/reserve-10.png", fallbackImage);
    await ingestSourceManifest(db, {
      sources: [fallbackSource],
      resources: [{ ...resource, sourceId: fallbackSource.id, url: fallbackUrl }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(fallbackHtml)) as typeof fetch });
    const unavailableFetch = vi.fn(async () => { throw new Error("origin unavailable"); }) as unknown as typeof fetch;
    const report = await ingestSourceManifest(db, {
      sources: [{ ...OFFICIAL_SOURCE, mediaPolicy: "link_only" }],
      resources: [resource],
    }, { apply: true, fetchImpl: unavailableFetch });

    expect(report.errors[0]?.error).toMatch(/origin unavailable/i);
    expect((await db.select().from(schema.catalogSources).where(eq(schema.catalogSources.id, OFFICIAL_SOURCE.id)))[0].mediaPolicy)
      .toBe("link_only");
    expect((await db.select().from(schema.bottleMedia)).map((media) => ({
      url: media.url,
      rights: media.rights,
      canonicalized: media.canonicalized,
    })).sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: fallbackImage, rights: "display_remote", canonicalized: true },
      { url: "https://www.example-distillery.com/images/reserve-10.png", rights: "link_only", canonicalized: false },
    ]);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].imageUrl).toBe(fallbackImage);
  });

  it("preserves a matching curated image when restricted source media was never canonicalized", async () => {
    const curatedImage = "https://www.example-distillery.com/images/reserve-10.png";
    const bottle = await createTestBottle(db, {
      id: "curated-restricted-image",
      status: "verified",
      imageUrl: curatedImage,
    });
    const restrictedSource = { ...OFFICIAL_SOURCE, mediaPolicy: "review_required" as const };
    await ingestSourceManifest(db, {
      sources: [restrictedSource],
      resources: [{
        bottleId: bottle.id,
        sourceId: restrictedSource.id,
        url: "https://www.example-distillery.com/products/reserve-10",
        resourceType: "official_product",
        mediaKind: "bottle",
      }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch });

    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].imageUrl).toBe(curatedImage);
    expect((await db.select().from(schema.bottleMedia))[0].canonicalized).toBe(false);
  });

  it("keeps the most restrictive rights when different sources expose the same image", async () => {
    const bottle = await createTestBottle(db, { id: "media-policy-conflict", status: "imported" });
    const displaySource = { ...OFFICIAL_SOURCE, id: "display-source" };
    const reviewSource = { ...OFFICIAL_SOURCE, id: "review-source", mediaPolicy: "review_required" as const };
    const resource = (sourceId: string, path: string) => ({
      bottleId: bottle.id,
      sourceId,
      url: `https://www.example-distillery.com/${path}`,
      resourceType: "official_product" as const,
      mediaKind: "bottle" as const,
    });
    const page = (path: string) => PRODUCT_HTML.replace(
      "https://www.example-distillery.com/products/reserve-10",
      `https://www.example-distillery.com/${path}`,
    );

    await ingestSourceManifest(db, { sources: [displaySource], resources: [resource(displaySource.id, "display-page")] }, {
      apply: true,
      fetchImpl: (async () => htmlResponse(page("display-page"))) as typeof fetch,
    });
    await ingestSourceManifest(db, { sources: [reviewSource], resources: [resource(reviewSource.id, "review-page")] }, {
      apply: true,
      fetchImpl: (async () => htmlResponse(page("review-page"))) as typeof fetch,
    });
    await ingestSourceManifest(db, { sources: [displaySource], resources: [resource(displaySource.id, "display-page")] }, {
      apply: true,
      fetchImpl: (async () => htmlResponse(page("display-page"))) as typeof fetch,
    });

    expect((await db.select().from(schema.bottleMedia)).map((media) => media.rights).sort()).toEqual([
      "display_remote",
      "review_required",
    ]);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].imageUrl).toBeNull();

    const reviewWithoutImage = page("review-page")
      .replace('  <meta property="og:image" content="https://www.example-distillery.com/images/reserve-10.png" />\n', "")
      .replace('    "image":"https://www.example-distillery.com/images/reserve-10.png",\n', "");
    await ingestSourceManifest(db, { sources: [reviewSource], resources: [resource(reviewSource.id, "review-page")] }, {
      apply: true,
      fetchImpl: (async () => htmlResponse(reviewWithoutImage)) as typeof fetch,
    });

    expect(await db.select().from(schema.bottleMedia)).toEqual([
      expect.objectContaining({ rights: "display_remote", resourceId: expect.any(String) }),
    ]);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].imageUrl)
      .toBe("https://www.example-distillery.com/images/reserve-10.png");
  });

  it("does not verify a bottle when a structured page has no matching product", async () => {
    const bottle = await createTestBottle(db, { id: "unmatched-structured-product", name: "Expected Reserve", status: "imported", abv: null, imageUrl: null });
    const body = `<html><head>
      <title>Page not found</title>
      <meta property="og:image" content="https://www.example-distillery.com/images/unrelated.png" />
      <script type="application/ld+json">{"@type":"Product","name":"Other Reserve","image":"https://www.example-distillery.com/images/unrelated.png","additionalProperty":[{"@type":"PropertyValue","name":"ABV","value":"60%"}]}</script>
    </head></html>`;

    await ingestSourceManifest(db, {
      sources: [OFFICIAL_SOURCE],
      resources: [{
        bottleId: bottle.id,
        sourceId: OFFICIAL_SOURCE.id,
        url: "https://www.example-distillery.com/products/expected-reserve",
        resourceType: "official_product",
        mediaKind: "bottle",
      }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(body)) as typeof fetch });

    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      status: "imported",
      abv: null,
      imageUrl: null,
    });
    expect(await db.select().from(schema.bottleVerifications)).toEqual([]);
    expect(await db.select().from(schema.bottleMedia)).toEqual([]);
  });

  it("does not verify a bottle from an unfetched official link-only resource", async () => {
    const bottle = await createTestBottle(db, { id: "official-link-only", status: "imported", abv: null });
    const source = { ...OFFICIAL_SOURCE, fetchPolicy: "link_only" as const };
    const fetchImpl = vi.fn(async () => htmlResponse(PRODUCT_HTML)) as unknown as typeof fetch;

    await ingestSourceManifest(db, {
      sources: [source],
      resources: [{
        bottleId: bottle.id,
        sourceId: source.id,
        url: "https://www.example-distillery.com/products/reserve-10",
        resourceType: "official_product",
      }],
    }, { apply: true, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      status: "imported",
      abv: null,
    });
    expect(await db.select().from(schema.bottleVerifications)).toEqual([]);

    const structured = { ...source, fetchPolicy: "structured" as const };
    await ingestSourceManifest(db, {
      sources: [structured],
      resources: [{
        bottleId: bottle.id,
        sourceId: source.id,
        url: "https://www.example-distillery.com/products/reserve-10",
        resourceType: "official_product",
      }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch });
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].status).toBe("imported");
    expect((await db.select().from(schema.bottleClaims).where(eq(schema.bottleClaims.field, "abv")))[0].status)
      .toBe("corroborating");

    await ingestSourceManifest(db, {
      sources: [structured],
      resources: [{
        bottleId: bottle.id,
        sourceId: source.id,
        url: "https://www.example-distillery.com/products/reserve-10",
        resourceType: "official_product",
      }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch });
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].status).toBe("verified");
    expect((await db.select().from(schema.bottleClaims).where(eq(schema.bottleClaims.field, "abv")))[0].status)
      .toBe("accepted");
  });

  it("revokes verification when an official source is tightened to link-only", async () => {
    const bottle = await createTestBottle(db, { id: "official-policy-revocation", status: "imported", abv: null });
    const resource = {
      bottleId: bottle.id,
      sourceId: OFFICIAL_SOURCE.id,
      url: "https://www.example-distillery.com/products/reserve-10",
      resourceType: "official_product" as const,
    };
    await ingestSourceManifest(db, {
      sources: [OFFICIAL_SOURCE],
      resources: [resource],
    }, { apply: true, fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch });

    const linkOnly = { ...OFFICIAL_SOURCE, fetchPolicy: "link_only" as const };
    const fetchImpl = vi.fn(async () => { throw new Error("link-only should not fetch"); }) as unknown as typeof fetch;
    await ingestSourceManifest(db, { sources: [linkOnly], resources: [resource] }, { apply: true, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      status: "imported",
      abv: null,
    });
    expect(await db.select().from(schema.bottleVerifications)).toEqual([]);
    expect((await db.select().from(schema.catalogSources).where(eq(schema.catalogSources.id, OFFICIAL_SOURCE.id)))[0].fetchPolicy)
      .toBe("link_only");
  });

  it("stores editorial resources but cannot verify or overwrite a bottle", async () => {
    const bottle = await createTestBottle(db, { id: "editorial-only", status: "imported", abv: null });
    const source = { ...OFFICIAL_SOURCE, id: "breaking-bourbon", name: "Breaking Bourbon", kind: "editorial" as const, baseUrl: "https://www.breakingbourbon.com", mediaPolicy: "link_only" as const };
    const manifest: CatalogSourceManifest = {
      sources: [source],
      resources: [{ bottleId: bottle.id, sourceId: source.id, url: "https://www.breakingbourbon.com/review/example", resourceType: "review", mediaKind: "bottle" }],
    };
    const fetchImpl = vi.fn(async () => htmlResponse(PRODUCT_HTML)) as unknown as typeof fetch;

    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });
    const [updated] = await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id));
    expect(updated.status).toBe("imported");
    expect(updated.abv).toBeNull();
    expect(updated.imageUrl).toBeNull();
    expect(await db.select().from(schema.bottleResources)).toHaveLength(1);
    expect((await db.select().from(schema.bottleClaims)).some((claim) => claim.field === "description")).toBe(false);
  });

  it("never promotes displayable editorial media into the canonical bottle image", async () => {
    const bottle = await createTestBottle(db, { id: "editorial-image-scope", status: "imported", imageUrl: null });
    const editorial = {
      ...OFFICIAL_SOURCE,
      id: "editorial-images",
      kind: "editorial" as const,
      baseUrl: "https://reviews.example",
    };
    await ingestSourceManifest(db, {
      sources: [editorial],
      resources: [{ bottleId: bottle.id, sourceId: editorial.id, url: "https://reviews.example/review", resourceType: "review", mediaKind: "bottle" }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch });
    const officialWithoutImage = PRODUCT_HTML
      .replace('  <meta property="og:image" content="https://www.example-distillery.com/images/reserve-10.png" />\n', "")
      .replace('    "image":"https://www.example-distillery.com/images/reserve-10.png",\n', "");
    await ingestSourceManifest(db, {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/products/reserve-10", resourceType: "official_product", mediaKind: "bottle" }],
    }, { apply: true, fetchImpl: (async () => htmlResponse(officialWithoutImage)) as typeof fetch });

    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].imageUrl).toBeNull();
  });

  it("rejects source-id drift across manifests", async () => {
    const bottle = await createTestBottle(db, { id: "source-drift", status: "imported" });
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/products/reserve-10", resourceType: "official_product" }],
    };
    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch });

    await expect(ingestSourceManifest(db, {
      sources: [{ ...OFFICIAL_SOURCE, baseUrl: "https://other-producer.example" }],
      resources: [],
    }, { apply: true })).rejects.toThrow(/identity drift/i);
  });

  it("blocks cross-origin redirects before following them", async () => {
    const bottle = await createTestBottle(db, { id: "redirect-test", status: "imported" });
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/redirect", resourceType: "official_product" }],
    };
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    })) as unknown as typeof fetch;
    const report = await ingestSourceManifest(db, manifest, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.errors[0]?.error).toMatch(/HTTPS|public host/i);
  });

  it("resolves relative metadata against the final same-origin redirect URL", async () => {
    const bottle = await createTestBottle(db, { id: "redirect-relative", name: "Redirected Bottle", status: "imported", imageUrl: null });
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/old/page", resourceType: "official_product", mediaKind: "bottle" }],
    };
    const redirectedHtml = `<html><head>
      <link rel="canonical" href="./" />
      <meta property="og:title" content="Redirected Bottle" />
      <meta property="og:image" content="bottle.jpg" />
      <script type="application/ld+json">{"@type":"Product","name":"Redirected Bottle","image":"bottle.jpg"}</script>
    </head></html>`;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const current = String(url);
      if (current.endsWith("/old/page")) {
        return new Response(null, { status: 302, headers: { location: "/new/path/" } });
      }
      return htmlResponse(redirectedHtml);
    }) as unknown as typeof fetch;

    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl });

    expect(await db.select().from(schema.bottleResources)).toEqual([
      expect.objectContaining({ url: "https://www.example-distillery.com/new/path/" }),
    ]);
    expect(await db.select().from(schema.bottleMedia)).toEqual([
      expect.objectContaining({ url: "https://www.example-distillery.com/new/path/bottle.jpg" }),
    ]);
  });

  it("rejects chunked bodies as soon as they cross the streamed 2 MB limit", async () => {
    const bottle = await createTestBottle(db, { id: "oversized-source", status: "imported" });
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/oversized", resourceType: "official_product" }],
    };
    const chunk = new Uint8Array(1_100_000);
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

    const report = await ingestSourceManifest(db, manifest, { fetchImpl });

    expect(report.errors[0]?.error).toMatch(/2 MB limit/i);
  });

  it("revokes disabled-source authority without fetching and restores ownership when re-enabled", async () => {
    const bottle = await createTestBottle(db, { id: "disabled-source-refresh", status: "imported", abv: null });
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/products/reserve-10", resourceType: "official_product" }],
    };
    await ingestSourceManifest(db, manifest, {
      apply: true,
      fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch,
    });
    await db.update(schema.bottleVerifications).set({
      id: "legacy-random-verification-id",
      promotedBottle: true,
    });
    await db.update(schema.catalogSources).set({ enabled: false }).where(eq(schema.catalogSources.id, OFFICIAL_SOURCE.id));
    const unavailableFetch = vi.fn(async () => { throw new Error("origin unavailable"); }) as unknown as typeof fetch;
    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl: unavailableFetch });

    expect(unavailableFetch).not.toHaveBeenCalled();
    expect((await db.select().from(schema.catalogSources).where(eq(schema.catalogSources.id, OFFICIAL_SOURCE.id)))[0].enabled).toBe(false);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      status: "imported",
      abv: null,
    });
    expect(await db.select().from(schema.bottleClaims)).toEqual([]);
    expect(await db.select().from(schema.bottleVerifications)).toEqual([]);

    await db.update(schema.catalogSources).set({ enabled: true }).where(eq(schema.catalogSources.id, OFFICIAL_SOURCE.id));
    await ingestSourceManifest(db, manifest, {
      apply: true,
      fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch,
    });
    expect((await db.select().from(schema.bottleClaims).where(eq(schema.bottleClaims.field, "abv")))[0].canonicalized).toBe(true);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].abv).toBe(45);

    await ingestSourceManifest(db, manifest, {
      apply: true,
      fetchImpl: (async () => htmlResponse(PRODUCT_HTML.replace('"value":"45%"', '"value":"50%"'))) as typeof fetch,
    });
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].abv).toBe(50);
  });

  it("reports unknown bottle IDs in dry-run without fetching or writing sources", async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(PRODUCT_HTML)) as unknown as typeof fetch;
    const report = await ingestSourceManifest(db, {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: "missing-bottle", sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/products/reserve-10", resourceType: "official_product" }],
    }, { fetchImpl });

    expect(report.errors).toEqual([expect.objectContaining({ error: "Unknown bottle id: missing-bottle" })]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await db.select().from(schema.catalogSources)).toEqual([]);
  });

  it("dry-runs by default and makes no writes", async () => {
    const bottle = await createTestBottle(db, { id: "dry-run", status: "imported" });
    const manifest: CatalogSourceManifest = {
      sources: [OFFICIAL_SOURCE],
      resources: [{ bottleId: bottle.id, sourceId: OFFICIAL_SOURCE.id, url: "https://www.example-distillery.com/products/reserve-10", resourceType: "official_product", mediaKind: "bottle" }],
    };
    const report = await ingestSourceManifest(db, manifest, { fetchImpl: (async () => htmlResponse(PRODUCT_HTML)) as typeof fetch });
    expect(report.apply).toBe(false);
    expect(await db.select().from(schema.bottleResources)).toHaveLength(0);
  });
});

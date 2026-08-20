import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, setupTestDb } from "@/test/helpers";
import { buildSoldVerificationSchema, normalizeSoldVerification, persistSoldVerification } from "./verify-sold";
import { ingestSourceManifest, type CatalogSourceManifest } from "./source-backed";

describe("sold verification", () => {
  it("requires non-TTB product evidence before accepting a sale", () => {
    expect(normalizeSoldVerification({ id: "b", sold: true, evidenceUrl: "https://ttb.gov/cola", evidenceLabel: "TTB", evidenceKind: "manufacturer", retailerSku: null, upcs: [], abv: null, ageYears: null, price: null, description: null })).toBeNull();
    expect(normalizeSoldVerification({ id: "b", sold: true, evidenceUrl: "http://example-retailer.com/products/b", evidenceLabel: "Retailer", evidenceKind: "retailer", retailerSku: null, upcs: [], abv: null, ageYears: null, price: null, description: null })).toBeNull();
    expect(normalizeSoldVerification({ id: "b", sold: true, evidenceUrl: "https://example-retailer.com/products/b", evidenceLabel: "Retailer", evidenceKind: "retailer", retailerSku: "A-1", upcs: ["080244002145", "bad"], abv: 45, ageYears: 10, price: 49.99, description: "A product." })).toEqual(expect.objectContaining({ id: "b", upcs: ["080244002145"], abv: 45, price: 49.99 }));
  });

  it("persists verification evidence into the shared resource graph", async () => {
    const db: DB = await setupTestDb();
    const bottle = await createTestBottle(db, { id: "verified-resource", status: "imported" });
    const verification = normalizeSoldVerification({
      id: bottle.id,
      sold: true,
      evidenceUrl: "https://shop.example/products/bottle",
      evidenceLabel: "Example Shop",
      evidenceKind: "retailer",
      retailerSku: "SKU-1",
      upcs: [],
      abv: null,
      ageYears: null,
      price: null,
      description: null,
    });
    expect(verification).not.toBeNull();

    await persistSoldVerification(db, verification!, false);

    expect(await db.select().from(schema.catalogSources)).toEqual([
      expect.objectContaining({ kind: "retailer", name: "Example Shop", baseUrl: "https://shop.example" }),
    ]);
    expect(await db.select().from(schema.bottleResources)).toEqual([
      expect.objectContaining({ bottleId: bottle.id, resourceType: "retailer", url: "https://shop.example/products/bottle" }),
    ]);

    const [source] = await db.select().from(schema.catalogSources);
    const fetchImpl = vi.fn(async () => { throw new Error("retailer should remain link-only"); }) as unknown as typeof fetch;
    await ingestSourceManifest(db, {
      sources: [{
        id: source.id,
        name: source.name,
        kind: "retailer",
        baseUrl: source.baseUrl,
        fetchPolicy: "link_only",
        mediaPolicy: "link_only",
      }],
      resources: [{
        bottleId: bottle.id,
        sourceId: source.id,
        url: verification!.evidenceUrl!,
        resourceType: "retailer",
      }],
    }, { apply: true, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].status).toBe("verified");
    expect(await db.select().from(schema.bottleVerifications)).toHaveLength(1);
  });

  it("classifies manufacturer evidence as official product provenance", async () => {
    const db: DB = await setupTestDb();
    const bottle = await createTestBottle(db, { id: "manufacturer-resource", status: "imported", abv: null });
    await db.insert(schema.catalogSources).values({
      id: "trusted-producer",
      name: "Example Producer",
      kind: "official",
      baseUrl: "https://producer.example",
      fetchPolicy: "structured",
      mediaPolicy: "review_required",
    });
    await db.insert(schema.bottleResources).values({
      id: "existing-canonical-resource",
      bottleId: bottle.id,
      sourceId: "trusted-producer",
      resourceType: "official_product",
      url: "https://producer.example/products/bottle",
      title: "Existing canonical resource",
      retrievedAt: new Date(),
    });
    const verification = normalizeSoldVerification({
      id: bottle.id,
      sold: true,
      evidenceUrl: "https://producer.example/products/bottle",
      evidenceLabel: "Example Producer",
      evidenceKind: "manufacturer",
      retailerSku: null,
      upcs: [],
      abv: 46,
      ageYears: null,
      price: null,
      description: null,
    })!;

    await persistSoldVerification(db, verification, false);

    expect(await db.select().from(schema.catalogSources)).toEqual([
      expect.objectContaining({ kind: "official" }),
    ]);
    expect(await db.select().from(schema.bottleResources)).toEqual([
      expect.objectContaining({ resourceType: "official_product" }),
    ]);
    expect(await db.select().from(schema.bottleClaims)).toEqual([
      expect.objectContaining({
        resourceId: "existing-canonical-resource",
        field: "abv",
        value: 46,
        canonicalized: true,
      }),
    ]);
    expect(await db.select().from(schema.bottleVerifications)).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^verification-/), promotedBottle: true }),
    ]);

    await db.update(schema.catalogSources).set({ enabled: false }).where(eq(schema.catalogSources.id, "trusted-producer"));
    const manifest: CatalogSourceManifest = {
      sources: [{
        id: "trusted-producer",
        name: "Example Producer",
        kind: "official",
        baseUrl: "https://producer.example",
        fetchPolicy: "structured",
        mediaPolicy: "review_required",
      }],
      resources: [{
        bottleId: bottle.id,
        sourceId: "trusted-producer",
        url: verification.evidenceUrl!,
        resourceType: "official_product",
      }],
    };
    const unavailableFetch = vi.fn(async () => { throw new Error("origin unavailable"); }) as unknown as typeof fetch;
    await ingestSourceManifest(db, manifest, { apply: true, fetchImpl: unavailableFetch });

    expect(unavailableFetch).not.toHaveBeenCalled();
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      status: "imported",
      abv: null,
    });
    expect(await db.select().from(schema.bottleVerifications)).toEqual([]);
  });

  it("fails closed when an existing URL has incompatible provenance", async () => {
    const db: DB = await setupTestDb();
    const bottle = await createTestBottle(db, { id: "incompatible-resource", status: "imported", abv: null });
    await db.insert(schema.catalogSources).values({
      id: "trusted-producer",
      name: "Example Producer",
      kind: "official",
      baseUrl: "https://producer.example",
      fetchPolicy: "structured",
      mediaPolicy: "review_required",
    });
    await db.insert(schema.bottleResources).values({
      id: "existing-review-resource",
      bottleId: bottle.id,
      sourceId: "trusted-producer",
      resourceType: "review",
      url: "https://producer.example/products/bottle",
      retrievedAt: new Date(),
    });
    const verification = normalizeSoldVerification({
      id: bottle.id,
      sold: true,
      evidenceUrl: "https://producer.example/products/bottle",
      evidenceLabel: "Example Producer",
      evidenceKind: "manufacturer",
      retailerSku: null,
      upcs: [],
      abv: 46,
      ageYears: null,
      price: null,
      description: null,
    })!;

    expect(await persistSoldVerification(db, verification, false)).toBe(false);
    expect(await db.select().from(schema.bottleVerifications)).toEqual([]);
    expect(await db.select().from(schema.bottleClaims)).toEqual([]);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].status).toBe("imported");
  });

  it("rejects ambiguous official source authority for one origin", async () => {
    const db: DB = await setupTestDb();
    const bottle = await createTestBottle(db, { id: "ambiguous-origin", status: "imported", abv: null });
    await db.insert(schema.catalogSources).values([
      {
        id: "producer-a",
        name: "Producer A",
        kind: "official",
        baseUrl: "https://producer.example",
        fetchPolicy: "structured",
        mediaPolicy: "review_required",
      },
      {
        id: "producer-b",
        name: "Producer B",
        kind: "official",
        baseUrl: "https://producer.example",
        fetchPolicy: "structured",
        mediaPolicy: "review_required",
      },
    ]);
    const verification = normalizeSoldVerification({
      id: bottle.id,
      sold: true,
      evidenceUrl: "https://producer.example/products/bottle",
      evidenceLabel: "Producer",
      evidenceKind: "manufacturer",
      retailerSku: null,
      upcs: [],
      abv: 46,
      ageYears: null,
      price: null,
      description: null,
    })!;

    expect(await persistSoldVerification(db, verification, false)).toBe(false);
    expect(await db.select().from(schema.bottleVerifications)).toEqual([]);
    expect(await db.select().from(schema.bottleResources)).toEqual([]);
  });

  it("does not grant canonical facts from a link-only official origin", async () => {
    const db: DB = await setupTestDb();
    const bottle = await createTestBottle(db, { id: "link-only-manufacturer", status: "imported", abv: null, ageYears: null });
    await db.insert(schema.catalogSources).values({
      id: "link-only-producer",
      name: "Link-only producer",
      kind: "official",
      baseUrl: "https://producer.example",
      fetchPolicy: "link_only",
      mediaPolicy: "link_only",
    });
    const verification = normalizeSoldVerification({
      id: bottle.id,
      sold: true,
      evidenceUrl: "https://producer.example/products/bottle",
      evidenceLabel: "Producer",
      evidenceKind: "manufacturer",
      retailerSku: null,
      upcs: [],
      abv: 46,
      ageYears: 10,
      price: null,
      description: "Untrusted description",
    })!;

    expect(await persistSoldVerification(db, verification, false)).toBe(true);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0]).toMatchObject({
      status: "verified",
      abv: null,
      ageYears: null,
      description: null,
    });
    expect(await db.select().from(schema.bottleClaims)).toEqual([]);
    expect(await db.select().from(schema.bottleResources)).toEqual([
      expect.objectContaining({ resourceType: "producer" }),
    ]);
  });

  it("keeps uncurated manufacturer claims as non-authoritative producer evidence", async () => {
    const db: DB = await setupTestDb();
    const bottle = await createTestBottle(db, { id: "uncurated-manufacturer", status: "imported" });
    const verification = normalizeSoldVerification({
      id: bottle.id,
      sold: true,
      evidenceUrl: "https://unknown-producer.example/product",
      evidenceLabel: "Unknown Producer",
      evidenceKind: "manufacturer",
      retailerSku: null,
      upcs: [],
      abv: null,
      ageYears: null,
      price: null,
      description: null,
    })!;

    await persistSoldVerification(db, verification, false);

    expect(await db.select().from(schema.catalogSources)).toEqual([
      expect.objectContaining({ kind: "registry", fetchPolicy: "link_only" }),
    ]);
    expect(await db.select().from(schema.bottleResources)).toEqual([
      expect.objectContaining({ resourceType: "producer" }),
    ]);
  });

  it("quarantines verification evidence from any disabled origin", async () => {
    const db: DB = await setupTestDb();
    const bottle = await createTestBottle(db, { id: "disabled-evidence-origin", status: "imported" });
    await db.insert(schema.catalogSources).values({
      id: "disabled-origin",
      name: "Disabled origin",
      kind: "official",
      baseUrl: "https://blocked.example",
      fetchPolicy: "structured",
      mediaPolicy: "review_required",
      enabled: false,
    });
    const verification = normalizeSoldVerification({
      id: bottle.id,
      sold: true,
      evidenceUrl: "https://blocked.example/product",
      evidenceLabel: "Blocked",
      evidenceKind: "manufacturer",
      retailerSku: null,
      upcs: [],
      abv: 50,
      ageYears: 12,
      price: null,
      description: null,
    })!;

    expect(await persistSoldVerification(db, verification, false)).toBe(false);
    expect((await db.select().from(schema.bottles).where(eq(schema.bottles.id, bottle.id)))[0].status).toBe("imported");
    expect(await db.select().from(schema.bottleVerifications)).toEqual([]);
    expect(await db.select().from(schema.bottleResources)).toEqual([]);
  });

  it("requires every output field in the structured schema", () => {
    const root = buildSoldVerificationSchema() as { properties: { results: { items: { required: string[] } } } };
    const item = root.properties.results.items;
    expect(item.required).toContain("evidenceUrl");
    expect(item.required).toContain("evidenceKind");
    expect(item.required).toContain("upcs");
    expect(item.required).toContain("price");
  });
});

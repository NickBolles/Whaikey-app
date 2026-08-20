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
      expect.objectContaining({ field: "abv", value: 46, canonicalized: true }),
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

import { describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, setupTestDb } from "@/test/helpers";
import { buildSoldVerificationSchema, normalizeSoldVerification, persistSoldVerification } from "./verify-sold";

describe("sold verification", () => {
  it("requires non-TTB product evidence before accepting a sale", () => {
    expect(normalizeSoldVerification({ id: "b", sold: true, evidenceUrl: "https://ttb.gov/cola", evidenceLabel: "TTB", retailerSku: null, upcs: [], abv: null, ageYears: null, price: null, description: null })).toBeNull();
    expect(normalizeSoldVerification({ id: "b", sold: true, evidenceUrl: "https://example-retailer.com/products/b", evidenceLabel: "Retailer", retailerSku: "A-1", upcs: ["080244002145", "bad"], abv: 45, ageYears: 10, price: 49.99, description: "A product." })).toEqual(expect.objectContaining({ id: "b", upcs: ["080244002145"], abv: 45, price: 49.99 }));
  });

  it("persists verification evidence into the shared resource graph", async () => {
    const db: DB = await setupTestDb();
    const bottle = await createTestBottle(db, { id: "verified-resource", status: "imported" });
    const verification = normalizeSoldVerification({
      id: bottle.id,
      sold: true,
      evidenceUrl: "https://shop.example/products/bottle",
      evidenceLabel: "Example Shop",
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

  it("requires every output field in the structured schema", () => {
    const root = buildSoldVerificationSchema() as { properties: { results: { items: { required: string[] } } } };
    const item = root.properties.results.items;
    expect(item.required).toContain("evidenceUrl");
    expect(item.required).toContain("upcs");
    expect(item.required).toContain("price");
  });
});

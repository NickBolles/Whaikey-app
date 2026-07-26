import { describe, expect, it } from "vitest";
import { buildSoldVerificationSchema, normalizeSoldVerification } from "./verify-sold";

describe("sold verification", () => {
  it("requires non-TTB product evidence before accepting a sale", () => {
    expect(normalizeSoldVerification({ id: "b", sold: true, evidenceUrl: "https://ttb.gov/cola", evidenceLabel: "TTB", retailerSku: null, upcs: [], abv: null, ageYears: null, price: null, description: null })).toBeNull();
    expect(normalizeSoldVerification({ id: "b", sold: true, evidenceUrl: "https://example-retailer.com/products/b", evidenceLabel: "Retailer", retailerSku: "A-1", upcs: ["080244002145", "bad"], abv: 45, ageYears: 10, price: 49.99, description: "A product." })).toEqual(expect.objectContaining({ id: "b", upcs: ["080244002145"], abv: 45, price: 49.99 }));
  });

  it("requires every output field in the structured schema", () => {
    const root = buildSoldVerificationSchema() as { properties: { results: { items: { required: string[] } } } };
    const item = root.properties.results.items;
    expect(item.required).toContain("evidenceUrl");
    expect(item.required).toContain("upcs");
    expect(item.required).toContain("price");
  });
});

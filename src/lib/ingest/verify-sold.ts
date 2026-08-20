import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "@/db";
import { bottleClaims, bottleResources, bottles, bottleUpcs, bottleVerifications, catalogSources, priceHistory } from "@/db/schema";
import { isValidUpc } from "@/lib/upc";

export type VerificationCandidate = {
  id: string;
  name: string;
  category: string;
  region: string | null;
  abv: number | null;
  ageYears: number | null;
};

export type SoldVerification = {
  id: string;
  sold: boolean;
  evidenceUrl: string | null;
  evidenceLabel: string | null;
  evidenceKind: "manufacturer" | "retailer";
  retailerSku: string | null;
  upcs: string[];
  abv: number | null;
  ageYears: number | null;
  price: number | null;
  description: string | null;
};

export function buildSoldVerificationSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" }, sold: { type: "boolean" },
            evidenceUrl: { type: ["string", "null"] }, evidenceLabel: { type: ["string", "null"] },
            evidenceKind: { type: ["string", "null"], enum: ["manufacturer", "retailer", null] },
            retailerSku: { type: ["string", "null"] }, upcs: { type: "array", items: { type: "string" } },
            abv: { type: ["number", "null"] }, ageYears: { type: ["integer", "null"] },
            price: { type: ["number", "null"] }, description: { type: ["string", "null"] },
          },
          required: ["id", "sold", "evidenceUrl", "evidenceLabel", "evidenceKind", "retailerSku", "upcs", "abv", "ageYears", "price", "description"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };
}

export function buildSoldVerificationPrompt(rows: VerificationCandidate[]): string {
  return `Verify whether each TTB-label-derived whiskey is an actual consumer product currently or historically offered for sale. Search the web. A TTB COLA record alone is NOT evidence.\n\nFor sold=true, require a specific manufacturer or retailer product page and return its direct http(s) URL, source label, and evidenceKind (manufacturer or retailer). Only return facts explicitly supported by that page. Never guess a UPC, retailer SKU, price, ABV, age, or description. If no qualifying product page exists, return sold=false with all fact fields null/empty and evidenceKind=null. UPCs must be numeric GTINs as printed by the source. Retailer SKU is source context only.\n\nReturn a JSON object with a results array containing one result per supplied id. Candidates:\n${JSON.stringify(rows)}`;
}

function finiteInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname.endsWith("ttb.gov")) return null;
    return url.toString();
  } catch { return null; }
}

/** Reject rather than partially trust any claimed sale without non-TTB evidence. */
export function normalizeSoldVerification(value: unknown): SoldVerification | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.sold !== true) return null;
  const evidenceUrl = safeUrl(row.evidenceUrl);
  if (!evidenceUrl) return null;
  if (row.evidenceKind !== "manufacturer" && row.evidenceKind !== "retailer") return null;
  const upcs = Array.isArray(row.upcs)
    ? [...new Set(row.upcs.filter((v): v is string => typeof v === "string").map((v) => v.replace(/\D/g, "")).filter(isValidUpc))]
    : [];
  return {
    id: row.id, sold: true, evidenceUrl,
    evidenceKind: row.evidenceKind,
    evidenceLabel: typeof row.evidenceLabel === "string" && row.evidenceLabel.trim() ? row.evidenceLabel.trim().slice(0, 200) : null,
    retailerSku: typeof row.retailerSku === "string" && row.retailerSku.trim() ? row.retailerSku.trim().slice(0, 200) : null,
    upcs, abv: finiteInRange(row.abv, 0, 100), ageYears: finiteInRange(row.ageYears, 0, 100),
    price: finiteInRange(row.price, 0.01, 100_000),
    description: typeof row.description === "string" && row.description.trim() ? row.description.trim().slice(0, 2_000) : null,
  };
}

export async function findImportedBottles(db: DB, limit: number): Promise<VerificationCandidate[]> {
  return db.select({ id: bottles.id, name: bottles.name, category: bottles.category, region: bottles.region, abv: bottles.abv, ageYears: bottles.ageYears })
    .from(bottles).where(eq(bottles.status, "imported")).limit(limit);
}

function stableEvidenceId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function stableVerificationId(bottleId: string, url: string): string {
  return `verification-${createHash("sha256").update([bottleId, url].join("\u0000")).digest("hex").slice(0, 24)}`;
}

/** Persist only source-backed, normalized facts; existing curated values always win. */
export async function persistSoldVerification(db: DB, verification: SoldVerification, dryRun: boolean): Promise<boolean> {
  const [current] = await db.select().from(bottles).where(and(eq(bottles.id, verification.id), eq(bottles.status, "imported"))).limit(1);
  if (!current || !verification.evidenceUrl) return false;
  if (dryRun) return true;

  const evidence = new URL(verification.evidenceUrl);
  const [disabledOrigin] = await db.select({ id: catalogSources.id }).from(catalogSources).where(and(
    eq(catalogSources.baseUrl, evidence.origin),
    eq(catalogSources.enabled, false),
  )).limit(1);
  if (disabledOrigin) return false;

  await db.insert(bottleVerifications).values({
    id: stableVerificationId(current.id, verification.evidenceUrl),
    bottleId: current.id,
    url: verification.evidenceUrl,
    label: verification.evidenceLabel,
    retailerSku: verification.retailerSku,
    retrievedAt: new Date(),
    promotedBottle: true,
  }).onConflictDoNothing();

  // Bridge the existing verifier into the shared resource graph so every new
  // evidence URL appears on the bottle page without copying source prose.
  const claimsManufacturer = verification.evidenceKind === "manufacturer";
  const [trustedManufacturer] = claimsManufacturer
    ? await db.select({
        id: catalogSources.id,
        name: catalogSources.name,
        attribution: catalogSources.attribution,
        fetchPolicy: catalogSources.fetchPolicy,
        mediaPolicy: catalogSources.mediaPolicy,
      }).from(catalogSources).where(and(
        eq(catalogSources.kind, "official"),
        eq(catalogSources.baseUrl, evidence.origin),
        eq(catalogSources.enabled, true),
      )).limit(1)
    : [];
  const sourceKind = trustedManufacturer ? "official" as const :
    claimsManufacturer ? "registry" as const : "retailer" as const;
  const sourceId = trustedManufacturer?.id ??
    stableEvidenceId("verification-source", `${sourceKind}\u0000${evidence.origin}`);
  await db.insert(catalogSources).values({
    id: sourceId,
    name: trustedManufacturer?.name ?? verification.evidenceLabel ?? evidence.hostname,
    kind: sourceKind,
    baseUrl: evidence.origin,
    fetchPolicy: trustedManufacturer?.fetchPolicy ?? "link_only",
    mediaPolicy: trustedManufacturer?.mediaPolicy ?? "link_only",
    attribution: trustedManufacturer?.attribution ?? verification.evidenceLabel,
  }).onConflictDoNothing();
  const resourceId = stableEvidenceId("resource", `${current.id}\u0000${verification.evidenceUrl}`);
  await db.insert(bottleResources).values({
    id: resourceId,
    bottleId: current.id,
    sourceId,
    resourceType: trustedManufacturer ? "official_product" : claimsManufacturer ? "producer" : "retailer",
    url: verification.evidenceUrl,
    title: verification.evidenceLabel,
    publisher: verification.evidenceLabel,
    retrievedAt: new Date(),
  }).onConflictDoNothing();

  if (trustedManufacturer) {
    const canonicalFacts: Array<{ field: "abv" | "ageYears"; value: number }> = [];
    if (current.abv == null && verification.abv != null) canonicalFacts.push({ field: "abv", value: verification.abv });
    if (current.ageYears == null && verification.ageYears != null) canonicalFacts.push({ field: "ageYears", value: verification.ageYears });
    for (const fact of canonicalFacts) {
      const valueHash = createHash("sha256").update(JSON.stringify(fact.value)).digest("hex");
      await db.insert(bottleClaims).values({
        id: stableEvidenceId("claim", `${resourceId}\u0000${fact.field}\u0000${valueHash}`),
        bottleId: current.id,
        resourceId,
        field: fact.field,
        value: fact.value,
        valueHash,
        status: "accepted",
        canonicalized: true,
      }).onConflictDoUpdate({
        target: [bottleClaims.resourceId, bottleClaims.field, bottleClaims.valueHash],
        set: { status: "accepted", canonicalized: true },
      });
    }
  }

  const patch: Record<string, unknown> = { status: "verified" };
  if (current.abv == null && verification.abv != null) patch.abv = verification.abv;
  if (current.ageYears == null && verification.ageYears != null) patch.ageYears = verification.ageYears;
  if (current.avgPrice == null && verification.price != null) patch.avgPrice = verification.price;
  if (current.description == null && verification.description != null) patch.description = verification.description;
  await db.update(bottles).set(patch).where(eq(bottles.id, current.id));
  for (const upc of verification.upcs) {
    await db.insert(bottleUpcs).values({ id: `${current.id}--verified-${upc}`, bottleId: current.id, upc, source: "verified", confirmedCount: 0 }).onConflictDoNothing();
  }
  if (verification.price != null) {
    const source = `verified:${verification.evidenceUrl}`;
    const exists = await db.select({ id: priceHistory.id }).from(priceHistory).where(and(eq(priceHistory.bottleId, current.id), eq(priceHistory.source, source))).limit(1);
    if (!exists.length) await db.insert(priceHistory).values({ id: randomUUID(), bottleId: current.id, date: new Date(), price: verification.price, source });
  }
  return true;
}

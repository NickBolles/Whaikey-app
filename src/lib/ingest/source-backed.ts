import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { DB } from "@/db";
import {
  bottleClaims,
  bottleMedia,
  bottleResources,
  BOTTLE_MEDIA_KINDS,
  BOTTLE_RESOURCE_TYPES,
  bottles,
  bottleVerifications,
  CATALOG_FETCH_POLICIES,
  CATALOG_MEDIA_POLICIES,
  CATALOG_SOURCE_KINDS,
  catalogSources,
  type BottleClaimField,
  type BottleMediaKind,
  type BottleResourceType,
  type CatalogFetchPolicy,
  type CatalogMediaPolicy,
  type CatalogSourceKind,
} from "@/db/schema";
import { isValidUpc } from "@/lib/upc";

export interface CatalogSourceDefinition {
  id: string;
  name: string;
  kind: CatalogSourceKind;
  baseUrl: string;
  fetchPolicy: CatalogFetchPolicy;
  mediaPolicy: CatalogMediaPolicy;
  attribution?: string;
}

export interface CatalogResourceDefinition {
  bottleId: string;
  sourceId: string;
  url: string;
  resourceType: BottleResourceType;
  mediaKind?: BottleMediaKind;
  title?: string;
}

export interface CatalogSourceManifest {
  sources: CatalogSourceDefinition[];
  resources: CatalogResourceDefinition[];
}

export interface ExtractedClaim {
  field: BottleClaimField;
  value: string | number | Record<string, string>;
}

export interface ExtractedMedia {
  kind: BottleMediaKind;
  url: string;
  alt: string | null;
  rights: CatalogMediaPolicy;
  attribution: string | null;
  width: number | null;
  height: number | null;
}

export interface ParsedSourceDocument {
  title: string | null;
  publisher: string | null;
  canonicalUrl: string;
  publishedAt: Date | null;
  contentHash: string;
  claims: ExtractedClaim[];
  media: ExtractedMedia[];
  primaryProductMatched: boolean;
}

interface ParseInput {
  url: string;
  contentType: string;
  body: string;
  source: CatalogSourceDefinition;
  resourceType: BottleResourceType;
  mediaKind?: BottleMediaKind;
  expectedBottleName?: string;
}

const MAX_DOCUMENT_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;
const MEDIA_POLICY_RANK: Record<CatalogMediaPolicy, number> = {
  display_remote: 0,
  review_required: 1,
  link_only: 2,
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${hash(parts.join("\u0000")).slice(0, 24)}`;
}

const hasNoEnabledRestrictedTwin = sql<boolean>`NOT EXISTS (
  SELECT 1
  FROM bottle_media AS restricted_media
  INNER JOIN bottle_resources AS restricted_resource ON restricted_media.resource_id = restricted_resource.id
  INNER JOIN catalog_sources AS restricted_source ON restricted_resource.source_id = restricted_source.id
  WHERE restricted_media.bottle_id = ${bottleMedia.bottleId}
    AND restricted_media.url = ${bottleMedia.url}
    AND restricted_media.rights <> 'display_remote'
    AND restricted_source.enabled = true
)`;

function isPublicIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113));
}

/** True only for globally routable IP addresses, including mapped IPv6. */
export function isPublicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (isIP(normalized) === 4) return isPublicIpv4(normalized);
  if (isIP(normalized) !== 6) return false;

  const mapped = normalized.match(/::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    if (mapped[1]) return isPublicIpv4(mapped[1]);
    const high = Number.parseInt(mapped[2], 16);
    const low = Number.parseInt(mapped[3], 16);
    return isPublicIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }

  const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff && !normalized.startsWith("2001:db8:");
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  const ipVersion = isIP(host);
  if (ipVersion !== 0) return isPublicIpAddress(host);
  return host.includes(".");
}

/** Validate operator input before any network request. */
export function validatePublicSourceUrl(value: string, source: CatalogSourceDefinition): URL {
  let url: URL;
  let base: URL;
  try {
    url = new URL(value);
    base = new URL(source.baseUrl);
  } catch {
    throw new Error("Catalog source URL must be absolute");
  }
  if (url.protocol !== "https:" || base.protocol !== "https:") {
    throw new Error("Catalog source URL must use HTTPS");
  }
  if (url.username || url.password) throw new Error("Catalog source URL must not contain credentials");
  if (!isPublicHostname(url.hostname)) throw new Error("Catalog source URL must use a public host");
  if (url.origin !== base.origin) throw new Error(`Catalog resource is outside source origin ${base.origin}`);
  if (source.kind === "official" && /(^|\.)ttb\.gov$/i.test(url.hostname)) {
    throw new Error("TTB registry pages cannot be official product evidence");
  }
  url.hash = "";
  return url;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(re)) out[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? "");
  return out;
}

function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if ((attrs.property ?? attrs.name)?.toLowerCase() === key.toLowerCase() && attrs.content) {
      return attrs.content.trim();
    }
  }
  return null;
}

function canonicalHref(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (attrs.rel?.toLowerCase().split(/\s+/).includes("canonical") && attrs.href) return attrs.href.trim();
  }
  return null;
}

function pageTitle(html: string): string | null {
  const og = metaContent(html, "og:title");
  if (og) return og.slice(0, 300);
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].replace(/\s+/g, " ").trim()).slice(0, 300) : null;
}

function jsonLdObjects(html: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const attrs = attributes(script[1]);
    if (attrs.type?.toLowerCase() !== "application/ld+json") continue;
    try {
      const raw = script[2].trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        parsed = JSON.parse(decodeHtml(raw)) as unknown;
      }
      collectObjects(parsed, objects);
    } catch {
      // A malformed JSON-LD block does not invalidate other metadata.
    }
  }
  return objects;
}

function collectObjects(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  out.push(row);
  if (Array.isArray(row["@graph"])) collectObjects(row["@graph"], out);
}

function schemaTypes(row: Record<string, unknown>): string[] {
  const value = row["@type"];
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function namedValue(value: unknown): string | null {
  if (typeof value === "string") return stringValue(value);
  if (!value || typeof value !== "object") return null;
  return stringValue((value as Record<string, unknown>).name);
}

function imageValue(value: unknown): { url: string; width: number | null; height: number | null } | null {
  if (Array.isArray(value)) return imageValue(value[0]);
  if (typeof value === "string") return { url: value, width: null, height: null };
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const url = stringValue(row.url ?? row.contentUrl);
  if (!url) return null;
  return {
    url,
    width: typeof row.width === "number" && row.width > 0 ? Math.round(row.width) : null,
    height: typeof row.height === "number" && row.height > 0 ? Math.round(row.height) : null,
  };
}

function numberFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function wholeAgeYears(property: Record<string, unknown>, name: string, value: unknown, numeric: number): number | null {
  const unit = [
    stringValue(property.unitText),
    stringValue(property.unitCode),
    typeof value === "string" ? value : null,
    name,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(month|months|mon)\b/.test(unit)) {
    return numeric % 12 === 0 && numeric / 12 <= 100 ? numeric / 12 : null;
  }
  if (/\b(day|days|week|weeks|hour|hours)\b/.test(unit)) return null;
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 100 ? numeric : null;
}

function pushClaim(claims: ExtractedClaim[], field: BottleClaimField, value: ExtractedClaim["value"] | null): void {
  if (value == null || value === "") return;
  const encoded = JSON.stringify(value);
  if (!claims.some((claim) => claim.field === field && JSON.stringify(claim.value) === encoded)) {
    claims.push({ field, value });
  }
}

function productProperties(product: Record<string, unknown>, claims: ExtractedClaim[], includeDescription: boolean): void {
  pushClaim(claims, "name", stringValue(product.name));
  pushClaim(claims, "brand", namedValue(product.brand));
  const description = stringValue(product.description);
  if (includeDescription && description) pushClaim(claims, "description", description.slice(0, 2_000));
  pushClaim(claims, "sku", stringValue(product.sku));
  const gtin = stringValue(product.gtin ?? product.gtin12 ?? product.gtin13 ?? product.gtin14)?.replace(/\D/g, "") ?? null;
  if (gtin && isValidUpc(gtin)) pushClaim(claims, "gtin", gtin);

  const properties = Array.isArray(product.additionalProperty) ? product.additionalProperty : [];
  for (const property of properties) {
    if (!property || typeof property !== "object") continue;
    const row = property as Record<string, unknown>;
    const name = stringValue(row.name)?.toLowerCase() ?? "";
    const value = row.value;
    const numeric = numberFrom(value);
    if (numeric == null) continue;
    if (/\babv\b|alcohol by volume/.test(name) && numeric >= 0 && numeric <= 100) pushClaim(claims, "abv", numeric);
    if (/\bage\b|aged/.test(name)) pushClaim(claims, "ageYears", wholeAgeYears(row, name, value, numeric));
  }
  const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  if (offer && typeof offer === "object") {
    const price = numberFrom((offer as Record<string, unknown>).price);
    if (price != null && price > 0 && price <= 100_000) pushClaim(claims, "price", price);
  }
}

function normalizeProductIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function productIdentityMatches(expected: string, candidate: string): boolean {
  if (!expected || !candidate) return false;
  if (expected === candidate) return true;
  const generic = new Set(["year", "years", "old", "whiskey", "whisky", "bourbon"]);
  const significant = (value: string) => value.split(" ").filter((token) => token && !generic.has(token));
  const expectedTokens = significant(expected);
  const candidateTokens = significant(candidate);
  return expectedTokens.length > 0 &&
    expectedTokens.length === candidateTokens.length &&
    expectedTokens.every((token, index) => token === candidateTokens[index]);
}

function primaryProductForPage(
  products: Record<string, unknown>[],
  html: string,
  requestedUrl: URL,
  expectedBottleName?: string,
): Record<string, unknown> | undefined {
  if (products.length === 0) return undefined;
  const title = normalizeProductIdentity(metaContent(html, "og:title") ?? pageTitle(html) ?? "");
  const expected = normalizeProductIdentity(expectedBottleName ?? "");
  const path = normalizeProductIdentity(decodeURIComponent(requestedUrl.pathname));
  let best = products[0];
  let bestScore = -1;
  for (const product of products) {
    const name = normalizeProductIdentity(stringValue(product.name) ?? "");
    if (!name) continue;
    if (expected && !productIdentityMatches(expected, name)) continue;
    let score = 0;
    if (expected && productIdentityMatches(expected, name)) score += 2_000;
    if (title === name) score += 1_000;
    else if (title.includes(name)) score += 500 + name.length;
    else if (name.includes(title) && title) score += 250 + title.length;
    const nameTokens = name.split(" ").filter((token) => token.length > 2);
    score += nameTokens.filter((token) => path.includes(token)).length * 10;
    if (score > bestScore) {
      best = product;
      bestScore = score;
    }
  }
  return bestScore >= 250 ? best : undefined;
}

function reviewMatchesProduct(
  review: Record<string, unknown>,
  primaryProduct: Record<string, unknown> | undefined,
  expectedBottleName?: string,
): boolean {
  if (!primaryProduct) return false;
  if (review.itemReviewed === primaryProduct) return true;
  const reviewedName = normalizeProductIdentity(namedValue(review.itemReviewed) ?? "");
  const selectedName = normalizeProductIdentity(stringValue(primaryProduct.name) ?? expectedBottleName ?? "");
  if (!reviewedName || !selectedName) return false;
  return reviewedName === selectedName;
}

/** Extract only bounded metadata/facts; article and review bodies are never returned. */
export function parseSourceDocument(input: ParseInput): ParsedSourceDocument {
  const requestedUrl = validatePublicSourceUrl(input.url, input.source);
  const claims: ExtractedClaim[] = [];
  const media: ExtractedMedia[] = [];
  const objects = input.contentType.includes("html") ? jsonLdObjects(input.body) : [];
  if (input.contentType.includes("json")) {
    try {
      collectObjects(JSON.parse(input.body) as unknown, objects);
    } catch {
      // Malformed JSON remains a valid link resource with no extracted facts.
    }
  }
  const html = input.contentType.includes("html") ? input.body : "";
  const reviews = objects.filter((row) => schemaTypes(row).some((type) => type === "Review"));
  const products = objects.filter((row) => schemaTypes(row).some((type) => type === "Product"));
  for (const review of reviews) {
    const itemReviewed = review.itemReviewed;
    if (itemReviewed && typeof itemReviewed === "object" &&
        schemaTypes(itemReviewed as Record<string, unknown>).some((type) => type === "Product") &&
        !products.includes(itemReviewed as Record<string, unknown>)) {
      products.push(itemReviewed as Record<string, unknown>);
    }
  }
  const primaryProduct = primaryProductForPage(products, html, requestedUrl, input.expectedBottleName);
  const officialProduct = input.source.kind === "official" && input.resourceType === "official_product";
  if (primaryProduct) productProperties(primaryProduct, claims, officialProduct);
  for (const review of reviews) {
    if (!reviewMatchesProduct(review, primaryProduct, input.expectedBottleName)) continue;
    const rating = review.reviewRating;
    if (!rating || typeof rating !== "object") continue;
    const row = rating as Record<string, unknown>;
    const score = stringValue(row.ratingValue) ?? (typeof row.ratingValue === "number" ? String(row.ratingValue) : null);
    const scale = stringValue(row.bestRating) ?? (typeof row.bestRating === "number" ? String(row.bestRating) : null);
    if (score) pushClaim(claims, "reviewScore", { score, ...(scale ? { scale } : {}) });
  }

  const rawCanonical = canonicalHref(html);
  let canonicalUrl = requestedUrl.toString();
  if (rawCanonical) {
    try {
      canonicalUrl = validatePublicSourceUrl(new URL(rawCanonical, requestedUrl).toString(), input.source).toString();
    } catch {
      canonicalUrl = requestedUrl.toString();
    }
  }

  const structuredImage = primaryProduct ? imageValue(primaryProduct.image) : null;
  const openGraphImage = metaContent(html, "og:image");
  const rawImage = officialProduct && !primaryProduct
    ? null
    : structuredImage ?? (openGraphImage ? { url: openGraphImage, width: null, height: null } : null);
  if (rawImage && input.mediaKind) {
    try {
      const mediaUrl = new URL(rawImage.url, requestedUrl);
      if (mediaUrl.protocol === "https:" && isPublicHostname(mediaUrl.hostname)) {
        media.push({
          kind: input.mediaKind,
          url: mediaUrl.toString(),
          alt: stringValue(primaryProduct?.name) ?? pageTitle(html),
          rights: input.source.mediaPolicy,
          attribution: input.source.attribution ?? input.source.name,
          width: rawImage.width,
          height: rawImage.height,
        });
      }
    } catch {
      // Invalid media URLs do not invalidate the resource itself.
    }
  }

  const publishedRaw = metaContent(html, "article:published_time");
  const publishedAt = publishedRaw && !Number.isNaN(Date.parse(publishedRaw)) ? new Date(publishedRaw) : null;
  return {
    title: pageTitle(html) ?? stringValue(primaryProduct?.name),
    publisher: metaContent(html, "og:site_name") ?? input.source.name,
    canonicalUrl,
    publishedAt,
    contentHash: hash(input.body),
    claims,
    media,
    primaryProductMatched: primaryProduct != null,
  };
}

export interface SourceIngestReport {
  apply: boolean;
  resources: number;
  fetched: number;
  claimsExtracted: number;
  mediaExtracted: number;
  resourcesWritten: number;
  claimsWritten: number;
  mediaWritten: number;
  bottlesPromoted: number;
  errors: Array<{ url: string; error: string }>;
}

function validateManifest(manifest: CatalogSourceManifest): Map<string, CatalogSourceDefinition> {
  if (!manifest || !Array.isArray(manifest.sources) || !Array.isArray(manifest.resources)) {
    throw new Error("Catalog source manifest must contain sources and resources arrays");
  }
  const sources = new Map<string, CatalogSourceDefinition>();
  for (const source of manifest.sources) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id) || !source.name?.trim() || source.name.length > 200) {
      throw new Error("Each catalog source needs a slug id and a bounded name");
    }
    if (!(CATALOG_SOURCE_KINDS as readonly string[]).includes(source.kind)) throw new Error(`Invalid source kind: ${source.kind}`);
    if (!(CATALOG_FETCH_POLICIES as readonly string[]).includes(source.fetchPolicy)) throw new Error(`Invalid fetch policy: ${source.fetchPolicy}`);
    if (!(CATALOG_MEDIA_POLICIES as readonly string[]).includes(source.mediaPolicy)) throw new Error(`Invalid media policy: ${source.mediaPolicy}`);
    if (sources.has(source.id)) throw new Error(`Duplicate catalog source id: ${source.id}`);
    validatePublicSourceUrl(source.baseUrl, { ...source, baseUrl: source.baseUrl });
    sources.set(source.id, source);
  }
  const resourceKeys = new Set<string>();
  for (const resource of manifest.resources) {
    if (!resource.bottleId?.trim() || resource.bottleId.length > 300) throw new Error("Each catalog resource needs a bottleId");
    if (resource.title && resource.title.length > 300) throw new Error("Catalog resource title is too long");
    if (!(BOTTLE_RESOURCE_TYPES as readonly string[]).includes(resource.resourceType)) throw new Error(`Invalid resource type: ${resource.resourceType}`);
    if (resource.mediaKind && !(BOTTLE_MEDIA_KINDS as readonly string[]).includes(resource.mediaKind)) throw new Error(`Invalid media kind: ${resource.mediaKind}`);
    const source = sources.get(resource.sourceId);
    if (!source) throw new Error(`Unknown sourceId: ${resource.sourceId}`);
    const normalizedUrl = validatePublicSourceUrl(resource.url, source).toString();
    const key = `${resource.bottleId}\u0000${normalizedUrl}`;
    if (resourceKeys.has(key)) throw new Error(`Duplicate catalog resource: ${resource.bottleId} ${normalizedUrl}`);
    resourceKeys.add(key);
  }
  return sources;
}

type HostResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export async function resolvePublicAddresses(hostname: string, resolver: HostResolver = async (host) =>
  lookup(host, { all: true, verbatim: true })): Promise<Array<{ address: string; family: number }>> {
  const addresses = await resolver(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error("Catalog source DNS resolved to a non-public address");
  }
  return addresses;
}

/** HTTPS request whose DNS lookup is pinned to an address validated above. */
async function fetchPublicHttps(url: string, signal: AbortSignal): Promise<Response> {
  const parsed = new URL(url);
  const [resolved] = await resolvePublicAddresses(parsed.hostname);
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(parsed, {
      headers: { "user-agent": "WhaikeyCatalog/1.0 (+source-backed metadata fetch)" },
      lookup: ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
        if ((options as { all?: boolean } | undefined)?.all) {
          callback(null, [{ address: resolved.address, family: resolved.family }]);
        } else {
          callback(null, resolved.address, resolved.family);
        }
      }) as never,
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value != null) headers.set(name, String(value));
      }
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: response.statusCode ?? 500,
        statusText: response.statusMessage,
        headers,
      }));
    });
    request.once("error", reject);
    const abort = () => request.destroy(new DOMException("Catalog fetch aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request.end();
  });
}

async function fetchDocument(url: string, source: CatalogSourceDefinition, fetchImpl?: typeof fetch): Promise<{ body: string; contentType: string; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let currentUrl = validatePublicSourceUrl(url, source).toString();
    let response: Response | null = null;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      response = fetchImpl
        ? await fetchImpl(currentUrl, {
            headers: { "user-agent": "WhaikeyCatalog/1.0 (+source-backed metadata fetch)" },
            redirect: "manual",
            signal: controller.signal,
          })
        : await fetchPublicHttps(currentUrl, controller.signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) throw new Error(`HTTP ${response.status} redirect omitted Location`);
      if (redirect === 3) throw new Error("Catalog source exceeded redirect limit");
      currentUrl = validatePublicSourceUrl(new URL(location, currentUrl).toString(), source).toString();
    }
    if (!response || !response.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
    if (response.url) validatePublicSourceUrl(response.url, source);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds 2 MB limit");
    if (!response.body) return { body: "", contentType: response.headers.get("content-type") ?? "text/html", finalUrl: currentUrl };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let body = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_DOCUMENT_BYTES) {
          await reader.cancel();
          throw new Error("Document exceeds 2 MB limit");
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return { body, contentType: response.headers.get("content-type") ?? "text/html", finalUrl: currentUrl };
  } finally {
    clearTimeout(timeout);
  }
}

function claimStatus(
  source: CatalogSourceDefinition,
  officialAuthority: boolean,
): "accepted" | "corroborating" | "review_required" {
  if (officialAuthority) return "accepted";
  if (source.kind === "registry") return "review_required";
  return "corroborating";
}

/** Fetch and persist a curated manifest. Dry-run is the default. */
export async function ingestSourceManifest(
  db: DB,
  manifest: CatalogSourceManifest,
  opts: { apply?: boolean; fetchImpl?: typeof fetch; concurrency?: number } = {},
): Promise<SourceIngestReport> {
  const apply = opts.apply === true;
  const fetchImpl = opts.fetchImpl;
  const sourceMap = validateManifest(manifest);
  const report: SourceIngestReport = {
    apply,
    resources: manifest.resources.length,
    fetched: 0,
    claimsExtracted: 0,
    mediaExtracted: 0,
    resourcesWritten: 0,
    claimsWritten: 0,
    mediaWritten: 0,
    bottlesPromoted: 0,
    errors: [],
  };

  const bottleIds = [...new Set(manifest.resources.map((resource) => resource.bottleId))];
  const existingBottleIds = bottleIds.length === 0
    ? new Set<string>()
    : new Set((await db.select({ id: bottles.id }).from(bottles).where(inArray(bottles.id, bottleIds))).map((row) => row.id));
  for (const resource of manifest.resources) {
    if (!existingBottleIds.has(resource.bottleId)) {
      report.errors.push({ url: resource.url, error: `Unknown bottle id: ${resource.bottleId}` });
    }
  }
  // Applying a manifest is all-or-nothing with respect to basic bottle identity:
  // do not upsert source rows before discovering an invalid assignment.
  if (report.errors.length > 0) return report;

  const disabledSourceIds = new Set<string>();
  const previouslyStructuredOfficialSourceIds = new Set<string>();
  const existingSourceIds = new Set<string>();
  const failedSourceIds = new Set<string>();
  const previousFetchPolicy = new Map<string, CatalogFetchPolicy>();
  const previousMediaPolicy = new Map<string, CatalogMediaPolicy>();
  if (apply) {
    for (const source of manifest.sources) {
      const baseUrl = new URL(source.baseUrl).origin;
      const [registered] = await db.select({
        baseUrl: catalogSources.baseUrl,
        kind: catalogSources.kind,
        fetchPolicy: catalogSources.fetchPolicy,
        mediaPolicy: catalogSources.mediaPolicy,
        enabled: catalogSources.enabled,
      })
        .from(catalogSources).where(eq(catalogSources.id, source.id)).limit(1);
      if (registered && (registered.baseUrl !== baseUrl || registered.kind !== source.kind)) {
        throw new Error(`Catalog source identity drift for ${source.id}; create a new source id`);
      }
      if (registered?.enabled === false) disabledSourceIds.add(source.id);
      if (registered) existingSourceIds.add(source.id);
      if (registered) {
        previousFetchPolicy.set(source.id, registered.fetchPolicy);
        previousMediaPolicy.set(source.id, registered.mediaPolicy);
      }
      if (registered?.kind === "official" && registered.fetchPolicy === "structured") {
        previouslyStructuredOfficialSourceIds.add(source.id);
      }
      if (registered && MEDIA_POLICY_RANK[source.mediaPolicy] > MEDIA_POLICY_RANK[registered.mediaPolicy]) {
        const sourceMedia = await db.select({
          id: bottleMedia.id,
          bottleId: bottleMedia.bottleId,
          url: bottleMedia.url,
          canonicalized: bottleMedia.canonicalized,
        }).from(bottleMedia)
          .innerJoin(bottleResources, eq(bottleMedia.resourceId, bottleResources.id))
          .where(eq(bottleResources.sourceId, source.id));
        if (sourceMedia.length > 0) {
          await db.update(bottleMedia).set({
            rights: source.mediaPolicy,
            canonicalized: false,
          }).where(inArray(bottleMedia.id, sourceMedia.map((media) => media.id)));
          for (const media of sourceMedia) {
            if (!media.canonicalized) continue;
            await db.update(bottles).set({ imageUrl: null }).where(and(
              eq(bottles.id, media.bottleId),
              eq(bottles.imageUrl, media.url),
            ));
          }
        }
        // Restrictive changes are safety revocations, not optimistic updates:
        // persist them even when one of the source's pages is unavailable.
        await db.update(catalogSources).set({
          mediaPolicy: source.mediaPolicy,
          updatedAt: new Date(),
        }).where(eq(catalogSources.id, source.id));
      }
      await db.insert(catalogSources).values({
        ...source,
        baseUrl,
      }).onConflictDoUpdate({
        target: catalogSources.id,
        set: {
          name: source.name,
          kind: source.kind,
          baseUrl: new URL(source.baseUrl).origin,
          attribution: source.attribution ?? null,
          updatedAt: new Date(),
        },
      });
    }
  }

  const processResource = async (resource: CatalogResourceDefinition): Promise<void> => {
    const source = sourceMap.get(resource.sourceId)!;
    try {
      const priorFetchPolicy = previousFetchPolicy.get(source.id);
      const priorMediaPolicy = previousMediaPolicy.get(source.id);
      const effectiveMediaPolicy = priorMediaPolicy && MEDIA_POLICY_RANK[priorMediaPolicy] > MEDIA_POLICY_RANK[source.mediaPolicy]
        ? priorMediaPolicy
        : source.mediaPolicy;
      const extractionSource = { ...source, mediaPolicy: effectiveMediaPolicy };
      const policyAllowsOfficialAuthority = priorFetchPolicy == null
        ? source.fetchPolicy === "structured"
        : priorFetchPolicy === "structured" && source.fetchPolicy === "structured";
      const requestedUrl = validatePublicSourceUrl(resource.url, source).toString();
      const [bottle] = await db.select().from(bottles).where(eq(bottles.id, resource.bottleId)).limit(1);
      if (!bottle) throw new Error(`Unknown bottle id: ${resource.bottleId}`);
      const manifestResourceId = stableId("resource", resource.bottleId, requestedUrl);
      const [disabledResource] = apply && disabledSourceIds.has(source.id)
        ? await db.select({
            id: bottleResources.id,
            url: bottleResources.url,
            title: bottleResources.title,
            publisher: bottleResources.publisher,
            contentHash: bottleResources.contentHash,
          }).from(bottleResources).where(and(
            eq(bottleResources.bottleId, resource.bottleId),
            eq(bottleResources.sourceId, source.id),
            or(eq(bottleResources.id, manifestResourceId), eq(bottleResources.url, requestedUrl)),
          )).limit(1)
        : [];
      let parsed: ParsedSourceDocument;
      if (apply && disabledSourceIds.has(source.id)) {
        if (!disabledResource) return;
        // Revocation must not depend on the disabled origin remaining online.
        // A synthetic empty snapshot drives the normal fallback/ownership path.
        parsed = {
          title: disabledResource.title,
          publisher: disabledResource.publisher,
          canonicalUrl: disabledResource.url,
          publishedAt: null,
          contentHash: hash(`disabled\u0000${disabledResource.contentHash ?? ""}`),
          claims: [],
          media: [],
          primaryProductMatched: false,
        };
      } else if (source.fetchPolicy === "link_only") {
        parsed = {
          title: resource.title ?? null,
          publisher: source.name,
          canonicalUrl: requestedUrl,
          publishedAt: null,
          contentHash: hash(requestedUrl),
          claims: [],
          media: [],
          primaryProductMatched: false,
        };
      } else {
        const document = await fetchDocument(requestedUrl, source, fetchImpl);
        report.fetched += 1;
        parsed = parseSourceDocument({
          url: document.finalUrl,
          body: document.body,
          contentType: document.contentType,
          source: extractionSource,
          resourceType: resource.resourceType,
          mediaKind: resource.mediaKind,
          expectedBottleName: bottle.name,
        });
      }
      report.claimsExtracted += parsed.claims.length;
      report.mediaExtracted += parsed.media.length;
      if (!apply) return;

      const extractionHash = hash(JSON.stringify({
        version: 1,
        document: parsed.contentHash,
        sourceKind: source.kind,
        sourceName: source.name,
        sourceAttribution: source.attribution ?? null,
        fetchPolicy: source.fetchPolicy,
        mediaPolicy: effectiveMediaPolicy,
        resourceType: resource.resourceType,
        mediaKind: resource.mediaKind ?? "bottle",
      }));
      const resourceAssociation = or(
        eq(bottleResources.id, manifestResourceId),
        eq(bottleResources.url, parsed.canonicalUrl),
      );
      const candidates = await db.select({
        id: bottleResources.id,
        url: bottleResources.url,
        contentHash: bottleResources.contentHash,
        resourceType: bottleResources.resourceType,
        sourceId: bottleResources.sourceId,
      }).from(bottleResources).where(and(
        eq(bottleResources.bottleId, bottle.id),
        resourceAssociation,
      ));
      const manifestMatch = candidates.find((candidate) => candidate.id === manifestResourceId);
      const canonicalMatch = candidates.find((candidate) => candidate.url === parsed.canonicalUrl);
      const existing = manifestMatch ?? canonicalMatch ?? candidates[0];
      const conflictingSource = candidates.find((candidate) => candidate.sourceId !== source.id);
      if (conflictingSource) {
        throw new Error(`Resource URL is already associated with source ${conflictingSource.sourceId}`);
      }
      const previouslyOfficialProduct = existing?.resourceType === "official_product" &&
        previouslyStructuredOfficialSourceIds.has(source.id);
      const resourceId = existing?.id ?? manifestResourceId;
      const priorResourceIds = candidates.map((candidate) => candidate.id);
      const priorCanonicalClaims = priorResourceIds.length === 0 ? [] : await db.select({
        field: bottleClaims.field,
        value: bottleClaims.value,
      }).from(bottleClaims).where(and(
        inArray(bottleClaims.resourceId, priorResourceIds),
        eq(bottleClaims.canonicalized, true),
      ));
      const priorCanonicalMedia = priorResourceIds.length === 0 ? [] : await db.select({
        url: bottleMedia.url,
      }).from(bottleMedia).where(and(
        inArray(bottleMedia.resourceId, priorResourceIds),
        eq(bottleMedia.canonicalized, true),
      ));
      const snapshotChanged = existing != null && existing.contentHash !== extractionHash;
      const trackedImageBefore = bottle.imageUrl
        ? await db.select({ id: bottleMedia.id }).from(bottleMedia).where(and(
          eq(bottleMedia.bottleId, bottle.id),
          eq(bottleMedia.url, bottle.imageUrl),
          eq(bottleMedia.canonicalized, true),
        )).limit(1)
        : [];
      // If a stable manifest URL now publishes a different canonical URL, retire
      // any duplicate row left by older ingestion and keep the manifest identity.
      for (const duplicate of candidates) {
        if (duplicate.id !== resourceId) await db.delete(bottleResources).where(eq(bottleResources.id, duplicate.id));
      }
      const resourceValues = {
        sourceId: source.id,
        resourceType: resource.resourceType,
        url: parsed.canonicalUrl,
        title: parsed.title ?? resource.title ?? null,
        publisher: parsed.publisher,
        contentHash: extractionHash,
        publishedAt: parsed.publishedAt,
        retrievedAt: new Date(),
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(bottleResources).set(resourceValues).where(eq(bottleResources.id, resourceId));
      } else {
        report.resourcesWritten += 1;
        await db.insert(bottleResources).values({
          id: resourceId,
          bottleId: bottle.id,
          ...resourceValues,
        });
      }

      // A changed page or extraction policy replaces its prior snapshot. Keeping
      // rows that the current classification no longer extracts (for example an
      // official Product.description after reclassification as a review) would
      // preserve stale authority and stale media rights.
      if (snapshotChanged) {
        await db.delete(bottleClaims).where(eq(bottleClaims.resourceId, resourceId));
        await db.delete(bottleMedia).where(eq(bottleMedia.resourceId, resourceId));
      }

      const officialProduct = source.kind === "official" &&
        policyAllowsOfficialAuthority && parsed.primaryProductMatched &&
        resource.resourceType === "official_product" && !disabledSourceIds.has(source.id);
      const priorCanonicalAbv = priorCanonicalClaims.find((claim) => claim.field === "abv")?.value;
      const priorCanonicalAge = priorCanonicalClaims.find((claim) => claim.field === "ageYears")?.value;
      const managesAbv = typeof priorCanonicalAbv === "number" && priorCanonicalAbv === bottle.abv;
      const managesAge = typeof priorCanonicalAge === "number" && priorCanonicalAge === bottle.ageYears;
      const managesImage = bottle.imageUrl != null && priorCanonicalMedia.some((media) => media.url === bottle.imageUrl);
      const status = claimStatus(source, officialProduct);
      for (const claim of parsed.claims) {
        const valueHash = hash(JSON.stringify(claim.value));
        const canonicalized = officialProduct && (
          (claim.field === "abv" && (bottle.abv == null || managesAbv)) ||
          (claim.field === "ageYears" && (bottle.ageYears == null || managesAge))
        );
        const found = await db.select({ id: bottleClaims.id }).from(bottleClaims).where(and(
          eq(bottleClaims.resourceId, resourceId),
          eq(bottleClaims.field, claim.field),
          eq(bottleClaims.valueHash, valueHash),
        )).limit(1);
        await db.insert(bottleClaims).values({
          id: stableId("claim", resourceId, claim.field, valueHash),
          bottleId: bottle.id,
          resourceId,
          field: claim.field,
          value: claim.value,
          valueHash,
          status,
          canonicalized,
        }).onConflictDoUpdate({
          target: [bottleClaims.resourceId, bottleClaims.field, bottleClaims.valueHash],
          set: { status, canonicalized },
        });
        if (found.length === 0) report.claimsWritten += 1;
      }

      for (const media of parsed.media) {
        const found = await db.select({ id: bottleMedia.id }).from(bottleMedia).where(and(
          eq(bottleMedia.resourceId, resourceId), eq(bottleMedia.url, media.url),
        )).limit(1);
        await db.insert(bottleMedia).values({
          id: stableId("media", resourceId, media.url),
          bottleId: bottle.id,
          resourceId,
          kind: media.kind,
          url: media.url,
          alt: media.alt,
          rights: media.rights,
          attribution: media.attribution,
          width: media.width,
          height: media.height,
          isPrimary: media.kind === "bottle",
        }).onConflictDoUpdate({
          target: [bottleMedia.resourceId, bottleMedia.url],
          set: {
            kind: media.kind,
            alt: media.alt,
            rights: media.rights,
            attribution: media.attribution,
            width: media.width,
            height: media.height,
            isPrimary: media.kind === "bottle",
          },
        });
        if (found.length === 0) report.mediaWritten += 1;
      }

      let clearManagedImage = false;
      if (bottle.imageUrl) {
        const trackedImageAfter = await db.select({ id: bottleMedia.id }).from(bottleMedia).where(and(
          eq(bottleMedia.bottleId, bottle.id),
          eq(bottleMedia.url, bottle.imageUrl),
          eq(bottleMedia.canonicalized, true),
        )).limit(1);
        if (trackedImageBefore.length > 0 || trackedImageAfter.length > 0) {
          const displayAllowed = await db.select({ id: bottleMedia.id }).from(bottleMedia)
            .innerJoin(bottleResources, eq(bottleMedia.resourceId, bottleResources.id))
            .innerJoin(catalogSources, eq(bottleResources.sourceId, catalogSources.id))
            .where(and(
              eq(bottleMedia.bottleId, bottle.id),
              eq(bottleMedia.url, bottle.imageUrl),
              eq(bottleMedia.rights, "display_remote"),
              eq(catalogSources.enabled, true),
              hasNoEnabledRestrictedTwin,
            )).limit(1);
          clearManagedImage = displayAllowed.length === 0;
        }
      }
      const fallbackClaim = async (field: "abv" | "ageYears") => {
        const [claim] = await db.select({ id: bottleClaims.id, value: bottleClaims.value })
          .from(bottleClaims)
          .innerJoin(bottleResources, eq(bottleClaims.resourceId, bottleResources.id))
          .innerJoin(catalogSources, eq(bottleResources.sourceId, catalogSources.id))
          .where(and(
            eq(bottleClaims.bottleId, bottle.id),
            eq(bottleClaims.field, field),
            eq(bottleClaims.status, "accepted"),
            ne(bottleClaims.resourceId, resourceId),
            eq(bottleResources.resourceType, "official_product"),
            eq(catalogSources.kind, "official"),
            eq(catalogSources.enabled, true),
          ))
          .orderBy(
            desc(bottleClaims.canonicalized),
            asc(catalogSources.id),
            asc(bottleResources.id),
            asc(bottleClaims.id),
          )
          .limit(1);
        return claim;
      };
      const transferClaimOwnership = async (field: "abv" | "ageYears", claimId: string) => {
        await db.update(bottleClaims).set({ canonicalized: false }).where(and(
          eq(bottleClaims.bottleId, bottle.id),
          eq(bottleClaims.field, field),
          eq(bottleClaims.canonicalized, true),
        ));
        await db.update(bottleClaims).set({ canonicalized: true }).where(eq(bottleClaims.id, claimId));
      };
      const transferImageOwnership = async (mediaId: string) => {
        await db.update(bottleMedia).set({ canonicalized: false }).where(and(
          eq(bottleMedia.bottleId, bottle.id),
          eq(bottleMedia.kind, "bottle"),
          eq(bottleMedia.canonicalized, true),
        ));
        await db.update(bottleMedia).set({ canonicalized: true }).where(eq(bottleMedia.id, mediaId));
      };
      const [restorableManagedImage] = await db.select({ id: bottleMedia.id, url: bottleMedia.url }).from(bottleMedia)
        .innerJoin(bottleResources, eq(bottleMedia.resourceId, bottleResources.id))
        .innerJoin(catalogSources, eq(bottleResources.sourceId, catalogSources.id))
        .where(and(
          eq(bottleMedia.bottleId, bottle.id),
          eq(bottleMedia.kind, "bottle"),
          eq(bottleMedia.rights, "display_remote"),
          eq(bottleResources.resourceType, "official_product"),
          eq(catalogSources.kind, "official"),
          eq(catalogSources.enabled, true),
          hasNoEnabledRestrictedTwin,
        ))
        .orderBy(
          desc(bottleMedia.canonicalized),
          asc(catalogSources.id),
          asc(bottleResources.id),
          desc(bottleMedia.isPrimary),
          asc(bottleMedia.id),
        )
        .limit(1);
      const verificationUrls = [...new Set([
        ...candidates.map((candidate) => candidate.url),
        parsed.canonicalUrl,
      ])];
      const priorVerifications = await db.select({ promotedBottle: bottleVerifications.promotedBottle })
        .from(bottleVerifications)
        .where(and(
          eq(bottleVerifications.bottleId, bottle.id),
          inArray(bottleVerifications.url, verificationUrls),
        ));
      const sourcePromotedBottle = priorVerifications.some((verification) => verification.promotedBottle);

      if (officialProduct) {
        const patch: Partial<typeof bottles.$inferInsert> = {};
        const value = (field: BottleClaimField) => parsed.claims.find((claim) => claim.field === field)?.value;
        const abv = value("abv");
        const ageYears = value("ageYears");
        const fallbackAbv = typeof abv === "number" ? undefined : await fallbackClaim("abv");
        const fallbackAge = typeof ageYears === "number" ? undefined : await fallbackClaim("ageYears");
        const nextAbv = typeof abv === "number" ? abv :
          typeof fallbackAbv?.value === "number" ? fallbackAbv.value : null;
        const nextAge = typeof ageYears === "number" ? ageYears :
          typeof fallbackAge?.value === "number" ? fallbackAge.value : null;
        const [image] = await db.select({ id: bottleMedia.id, url: bottleMedia.url }).from(bottleMedia)
          .innerJoin(bottleResources, eq(bottleMedia.resourceId, bottleResources.id))
          .innerJoin(catalogSources, eq(bottleResources.sourceId, catalogSources.id))
          .where(and(
            eq(bottleMedia.bottleId, bottle.id),
            eq(bottleMedia.resourceId, resourceId),
            eq(bottleMedia.kind, "bottle"),
            eq(bottleMedia.rights, "display_remote"),
            eq(catalogSources.enabled, true),
            hasNoEnabledRestrictedTwin,
          )).orderBy(desc(bottleMedia.isPrimary), desc(bottleMedia.createdAt)).limit(1);
        if (managesAbv) patch.abv = nextAbv;
        else if (bottle.abv == null && nextAbv != null) patch.abv = nextAbv;
        if (managesAge) patch.ageYears = nextAge;
        else if (bottle.ageYears == null && nextAge != null) patch.ageYears = nextAge;
        if (clearManagedImage || managesImage) patch.imageUrl = image?.url ?? restorableManagedImage?.url ?? null;
        else if (bottle.imageUrl == null && (image || restorableManagedImage)) {
          patch.imageUrl = image?.url ?? restorableManagedImage?.url;
        }
        if (bottle.status === "imported") {
          patch.status = "verified";
          report.bottlesPromoted += 1;
        }
        if (Object.keys(patch).length > 0) await db.update(bottles).set(patch).where(eq(bottles.id, bottle.id));
        if (fallbackAbv && patch.abv === fallbackAbv.value) {
          await transferClaimOwnership("abv", fallbackAbv.id);
        }
        if (fallbackAge && patch.ageYears === fallbackAge.value) {
          await transferClaimOwnership("ageYears", fallbackAge.id);
        }
        if (image && patch.imageUrl === image.url) {
          await transferImageOwnership(image.id);
        } else if (restorableManagedImage && patch.imageUrl === restorableManagedImage.url) {
          await transferImageOwnership(restorableManagedImage.id);
        }
        for (const previous of candidates) {
          if (previous.url !== parsed.canonicalUrl) {
            await db.delete(bottleVerifications).where(and(
              eq(bottleVerifications.bottleId, bottle.id),
              eq(bottleVerifications.url, previous.url),
            ));
          }
        }
        await db.insert(bottleVerifications).values({
          id: stableId("verification", bottle.id, parsed.canonicalUrl),
          bottleId: bottle.id,
          url: parsed.canonicalUrl,
          label: source.name,
          retailerSku: null,
          retrievedAt: new Date(),
          promotedBottle: sourcePromotedBottle || bottle.status === "imported",
        }).onConflictDoUpdate({
          target: [bottleVerifications.bottleId, bottleVerifications.url],
          set: {
            label: source.name,
            retrievedAt: new Date(),
            promotedBottle: sql`${bottleVerifications.promotedBottle} OR ${sourcePromotedBottle || bottle.status === "imported"}`,
          },
        });
      } else {
        const revokedCanonical: Partial<typeof bottles.$inferInsert> = {};
        const fallbackAbv = managesAbv ? await fallbackClaim("abv") : undefined;
        const fallbackAge = managesAge ? await fallbackClaim("ageYears") : undefined;
        if (managesAbv) revokedCanonical.abv = typeof fallbackAbv?.value === "number" ? fallbackAbv.value : null;
        if (managesAge) revokedCanonical.ageYears = typeof fallbackAge?.value === "number" ? fallbackAge.value : null;
        if (clearManagedImage || managesImage) revokedCanonical.imageUrl = restorableManagedImage?.url ?? null;
        if (previouslyOfficialProduct) {
          await db.delete(bottleVerifications).where(and(
            eq(bottleVerifications.bottleId, bottle.id),
            inArray(bottleVerifications.url, verificationUrls),
          ));
          const remainingVerification = await db.select({ id: bottleVerifications.id })
            .from(bottleVerifications)
            .where(eq(bottleVerifications.bottleId, bottle.id))
            .orderBy(bottleVerifications.createdAt)
            .limit(1);
          if (sourcePromotedBottle && bottle.status === "verified") {
            if (remainingVerification.length === 0) {
              revokedCanonical.status = "imported";
            } else {
              await db.update(bottleVerifications)
                .set({ promotedBottle: true })
                .where(eq(bottleVerifications.id, remainingVerification[0].id));
            }
          }
        }
        if (Object.keys(revokedCanonical).length > 0) {
          await db.update(bottles).set(revokedCanonical).where(eq(bottles.id, bottle.id));
        }
        if (fallbackAbv && revokedCanonical.abv === fallbackAbv.value) {
          await transferClaimOwnership("abv", fallbackAbv.id);
        }
        if (fallbackAge && revokedCanonical.ageYears === fallbackAge.value) {
          await transferClaimOwnership("ageYears", fallbackAge.id);
        }
        if (restorableManagedImage && revokedCanonical.imageUrl === restorableManagedImage.url) {
          await transferImageOwnership(restorableManagedImage.id);
        }
      }
    } catch (error) {
      failedSourceIds.add(source.id);
      report.errors.push({ url: resource.url, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const resourcesByBottle = new Map<string, CatalogResourceDefinition[]>();
  for (const resource of manifest.resources) {
    const group = resourcesByBottle.get(resource.bottleId) ?? [];
    group.push(resource);
    resourcesByBottle.set(resource.bottleId, group);
  }
  const bottleGroups = [...resourcesByBottle.values()];
  let cursor = 0;
  const concurrency = Math.min(Math.max(1, Math.floor(opts.concurrency ?? 4)), 8);
  async function worker(): Promise<void> {
    while (cursor < bottleGroups.length) {
      const group = bottleGroups[cursor];
      cursor += 1;
      // Canonical ownership is bottle-scoped. Keep resources for the same
      // bottle sequential while still processing different bottles in parallel.
      for (const resource of group) await processResource(resource);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, bottleGroups.length) }, () => worker()));
  if (apply) {
    for (const source of manifest.sources) {
      if (!existingSourceIds.has(source.id) || failedSourceIds.has(source.id)) continue;
      await db.update(catalogSources).set({
        fetchPolicy: source.fetchPolicy,
        mediaPolicy: source.mediaPolicy,
        updatedAt: new Date(),
      }).where(eq(catalogSources.id, source.id));
    }
  }
  return report;
}

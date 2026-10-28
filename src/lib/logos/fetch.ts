import { coreName, type WikidataCandidate } from "./match";
import { commonsLicense, NOMINATIVE_USE, type LogoLicense } from "./license";
import type { BrandLogoSource } from "@/db/schema";

/**
 * Network side of the logo pipeline. Every request goes through `politeFetch`:
 * an identifying User-Agent, a per-host minimum interval (Wikimedia asks for
 * ≤ 1 request/s from bots; brand sites get one request every 2 s), a timeout
 * and a byte cap. `fetchImpl` is injectable so tests never touch the network.
 */
export const LOGO_USER_AGENT = "CaskfolkLogoBot/1.0 (+https://whaikey-app.vercel.app; catalog logo backfill)";
const MAX_LOGO_BYTES = 96_000;
const MAX_PAGE_BYTES = 1_000_000;
const MIN_RASTER_PX = 120;

type FetchImpl = typeof fetch;

export class HostRateLimiter {
  private last = new Map<string, number>();
  constructor(
    private readonly intervalMs: (host: string) => number = (h) => (/wiki(data|media)\.org$/.test(h) ? 1_000 : 2_000),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {}
  async wait(url: string): Promise<void> {
    const host = new URL(url).hostname;
    const prev = this.last.get(host);
    const gap = this.intervalMs(host);
    if (prev != null) {
      const due = prev + gap - this.now();
      if (due > 0) await this.sleep(due);
    }
    this.last.set(host, this.now());
  }
}

export interface FetchContext {
  fetchImpl: FetchImpl;
  limiter: HostRateLimiter;
}

async function politeFetch(ctx: FetchContext, url: string, accept: string, maxBytes: number): Promise<{ body: Uint8Array; type: string; url: string } | null> {
  await ctx.limiter.wait(url);
  const res = await ctx.fetchImpl(url, {
    headers: { "user-agent": LOGO_USER_AGENT, accept },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) return null;
  return { body: buf, type: (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(), url: res.url || url };
}

async function getJson<T>(ctx: FetchContext, url: string): Promise<T | null> {
  const r = await politeFetch(ctx, url, "application/json, application/sparql-results+json", 8_000_000);
  if (!r) return null;
  return JSON.parse(new TextDecoder().decode(r.body)) as T;
}

// ---------------------------------------------------------------------------
// Wikidata
// ---------------------------------------------------------------------------

export interface WikidataProducer extends WikidataCandidate {
  /** Commons file names (P154 logo image, then P8972 small logo). */
  logoFiles: string[];
  website: string | null;
}

/**
 * Every whisky producer Wikidata knows: whisky distilleries, distilleries
 * producing whisky, and alcohol brands/trademarks that are whiskies. One
 * SPARQL request (a few hundred rows) instead of a search per brand.
 */
export const PRODUCERS_SPARQL = `SELECT ?item ?itemLabel ?countryLabel ?cls ?logo ?small ?web (GROUP_CONCAT(DISTINCT ?alias;separator="|") AS ?aliases) WHERE {
 { ?item wdt:P31/wdt:P279* wd:Q10373548 } UNION { ?item wdt:P31 wd:Q1251750 . ?item wdt:P1056/wdt:P279* wd:Q281 }
 UNION { ?item wdt:P31 wd:Q80359036 . ?item (wdt:P1056|wdt:P279|wdt:P31|wdt:P452)/wdt:P279* wd:Q281 }
 UNION { ?item wdt:P31/wdt:P279* wd:Q281 }
 ?item wdt:P31 ?cls .
 OPTIONAL { ?item wdt:P17 ?country } OPTIONAL { ?item wdt:P495 ?country }
 OPTIONAL { ?item wdt:P154 ?logo } OPTIONAL { ?item wdt:P8972 ?small } OPTIONAL { ?item wdt:P856 ?web }
 OPTIONAL { ?item skos:altLabel ?alias FILTER(lang(?alias)="en") }
 SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } GROUP BY ?item ?itemLabel ?countryLabel ?cls ?logo ?small ?web`;

type SparqlRow = Record<string, { value: string } | undefined>;

/** Fold SPARQL rows (one per combination) into one producer per item. */
export function foldProducers(rows: SparqlRow[]): WikidataProducer[] {
  const out = new Map<string, WikidataProducer>();
  const qid = (v?: { value: string }) => v?.value.split("/").pop() ?? "";
  const file = (v?: { value: string }) => (v ? decodeURIComponent(v.value.split("/Special:FilePath/").pop() ?? "").replace(/_/g, " ") : null);
  for (const r of rows) {
    const id = qid(r.item);
    if (!id) continue;
    const label = r.itemLabel?.value ?? id;
    if (/^Q\d+$/.test(label)) continue; // no English label
    const p = out.get(id) ?? { id, label, aliases: [], countries: [], instanceOf: [], logoFiles: [], website: null };
    const add = <T,>(list: T[], v: T | null | undefined) => {
      if (v && !list.includes(v)) list.push(v);
    };
    add(p.countries, r.countryLabel?.value);
    add(p.instanceOf, qid(r.cls));
    add(p.logoFiles, file(r.logo));
    add(p.logoFiles, file(r.small));
    for (const a of (r.aliases?.value ?? "").split("|")) add(p.aliases, a.trim() || null);
    if (!p.website && r.web?.value?.startsWith("https://")) p.website = r.web.value;
    else if (!p.website && r.web?.value?.startsWith("http://")) p.website = r.web.value.replace(/^http:/, "https:");
    out.set(id, p);
  }
  return [...out.values()];
}

export async function fetchWikidataProducers(ctx: FetchContext): Promise<WikidataProducer[]> {
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(PRODUCERS_SPARQL)}`;
  const data = await getJson<{ results: { bindings: SparqlRow[] } }>(ctx, url);
  if (!data) throw new Error("Wikidata SPARQL request failed");
  return foldProducers(data.results.bindings);
}

// ---------------------------------------------------------------------------
// Wikimedia Commons
// ---------------------------------------------------------------------------

export interface FetchedLogo {
  source: BrandLogoSource;
  /** Where a person can see the original (file page / icon URL). */
  pageUrl: string;
  license: LogoLicense;
  attribution: string | null;
  attributionUrl: string | null;
  contentType: string;
  data: Uint8Array;
  width: number | null;
  height: number | null;
}

interface CommonsInfo {
  query?: {
    pages?: Record<string, {
      title?: string;
      missing?: string;
      imageinfo?: Array<{
        thumburl?: string;
        url?: string;
        descriptionurl?: string;
        mime?: string;
        extmetadata?: Record<string, { value?: string } | undefined>;
      }>;
    }>;
  };
}

const stripHtml = (s: string | undefined) => (s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null;

/** A Commons file as a 256px-wide PNG thumbnail plus its license, or null. */
export async function commonsLogo(ctx: FetchContext, fileName: string, source: BrandLogoSource = "wikidata"): Promise<FetchedLogo | null> {
  const title = fileName.startsWith("File:") ? fileName : `File:${fileName}`;
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=256&titles=${encodeURIComponent(title)}`;
  const info = await getJson<CommonsInfo>(ctx, api);
  const page = Object.values(info?.query?.pages ?? {})[0];
  const ii = page?.imageinfo?.[0];
  if (!page || page.missing != null || !ii) return null;
  const meta = ii.extmetadata ?? {};
  const license = commonsLicense(meta.LicenseShortName?.value, meta.AttributionRequired?.value);
  if (!license) return null;
  const imageUrl = ii.thumburl ?? ii.url;
  if (!imageUrl) return null;
  const img = await politeFetch(ctx, imageUrl, "image/png,image/*", MAX_LOGO_BYTES);
  if (!img) return null;
  const sniffed = sniffImage(img.body);
  if (!sniffed || sniffed.type === "image/svg+xml") return null;
  const artist = stripHtml(meta.Artist?.value);
  const credit = stripHtml(meta.Credit?.value);
  return {
    source,
    pageUrl: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
    license,
    attribution: license.attributionRequired ? [artist ?? credit ?? "Wikimedia Commons", "via Wikimedia Commons"].join(", ") : artist ? `${artist} (via Wikimedia Commons)` : "Wikimedia Commons",
    attributionUrl: ii.descriptionurl ?? null,
    contentType: sniffed.type,
    data: img.body,
    width: sniffed.width,
    height: sniffed.height,
  };
}

/** Whether a Commons file title is plainly "<brand> logo" (or wordmark). */
export function isLogoFileFor(title: string, brandName: string): boolean {
  const t = coreName(title.replace(/^File:/i, "").replace(/\.(svg|png|jpe?g|gif|webp)$/i, ""));
  const core = coreName(brandName);
  if (!core) return false;
  return new RegExp(`^${core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (logo|wordmark|logotype)( [0-9]{4})?$`).test(t);
}

/** Search Commons for an exact "<brand> logo" file not linked from Wikidata. */
export async function commonsSearchLogo(ctx: FetchContext, brandName: string): Promise<FetchedLogo | null> {
  const q = `intitle:"${brandName.replace(/"/g, "")}" intitle:logo`;
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=10&srsearch=${encodeURIComponent(q)}`;
  const data = await getJson<{ query?: { search?: Array<{ title: string }> } }>(ctx, api);
  for (const hit of data?.query?.search ?? []) {
    if (!isLogoFileFor(hit.title, brandName)) continue;
    const logo = await commonsLogo(ctx, hit.title, "commons");
    if (logo) return logo;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Official site icon (nominative use)
// ---------------------------------------------------------------------------

export interface IconCandidate {
  url: string;
  kind: "jsonld" | "apple-touch-icon" | "svg-icon" | "icon";
  size: number;
}

/** Icon/logo candidates declared in a page's <head> and JSON-LD, best first. */
export function iconCandidates(html: string, pageUrl: string): IconCandidate[] {
  const out: IconCandidate[] = [];
  const abs = (href: string) => {
    try {
      const u = new URL(href.trim(), pageUrl);
      return u.protocol === "https:" ? u.toString() : null;
    } catch {
      return null;
    }
  };
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || !/icon/.test(rel)) continue;
    const url = abs(href);
    if (!url) continue;
    const sizes = /\bsizes\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
    const size = Math.max(0, ...sizes.split(/\s+/).map((s) => Number(s.split("x")[0]) || 0));
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (/\.ico(\?|$)/i.test(url) || type.includes("x-icon")) continue;
    if (rel.includes("apple-touch-icon")) out.push({ url, kind: "apple-touch-icon", size: size || 180 });
    else if (type.includes("svg") || /\.svg(\?|$)/i.test(url)) out.push({ url, kind: "svg-icon", size: 512 });
    else if (rel.includes("mask-icon")) continue;
    else out.push({ url, kind: "icon", size });
  }
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== "object") return;
        const o = v as Record<string, unknown>;
        const types = ([] as unknown[]).concat(o["@type"] ?? []).map(String);
        if (types.some((t) => /Organization|Brand|Corporation|LocalBusiness/.test(t)) && o.logo) {
          const logo = typeof o.logo === "string" ? o.logo : (o.logo as Record<string, unknown>).url;
          const url = typeof logo === "string" ? abs(logo) : null;
          if (url) out.push({ url, kind: "jsonld", size: 400 });
        }
        if (o["@graph"]) walk(o["@graph"]);
      };
      walk(JSON.parse(m[1]!));
    } catch {
      // malformed JSON-LD is common; ignore it
    }
  }
  const rank = { jsonld: 0, "apple-touch-icon": 1, "svg-icon": 2, icon: 3 } as const;
  return out
    .filter((c) => c.kind !== "icon" || c.size >= MIN_RASTER_PX)
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.size - a.size)
    .filter((c, i, all) => all.findIndex((x) => x.url === c.url) === i);
}

/** Minimal robots.txt check for our UA (or *) on a path. */
/** robots.txt path rule with `*` wildcards and a trailing `$` anchor (RFC 9309). */
export function robotsRuleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith("$");
  const body = (anchored ? rule.slice(0, -1) : rule).split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

export function robotsAllows(robots: string, path: string): boolean {
  let applies = false;
  let anyGroupForUs = false;
  const rules: Array<{ allow: boolean; path: string }> = [];
  const starRules: Array<{ allow: boolean; path: string }> = [];
  let inStar = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    const key = k!.toLowerCase();
    if (key === "user-agent") {
      const ua = v!.toLowerCase();
      applies = ua.includes("caskfolklogobot");
      inStar = ua === "*";
      if (applies) anyGroupForUs = true;
    } else if (key === "allow" || key === "disallow") {
      const rule = { allow: key === "allow", path: v! };
      if (applies) rules.push(rule);
      else if (inStar) starRules.push(rule);
    }
  }
  const use = anyGroupForUs ? rules : starRules;
  let best: { allow: boolean; path: string } | null = null;
  for (const r of use) {
    if (!r.path) continue;
    if (robotsRuleMatches(r.path, path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best ? best.allow : true;
}

/** Site icon of an official website, under nominative use — or null. */
export async function websiteLogo(
  ctx: FetchContext,
  website: string,
  pageIsBrand: (html: string) => boolean = () => true,
): Promise<FetchedLogo | null> {
  let home: URL;
  try {
    home = new URL(website);
  } catch {
    return null;
  }
  if (home.protocol !== "https:") return null;
  const robots = await politeFetch(ctx, `${home.origin}/robots.txt`, "text/plain", 200_000).catch(() => null);
  const robotsText = robots ? new TextDecoder().decode(robots.body) : "";
  if (!robotsAllows(robotsText, home.pathname || "/")) return null;
  const page = await politeFetch(ctx, home.toString(), "text/html", MAX_PAGE_BYTES).catch(() => null);
  if (!page || !page.type.includes("html")) return null;
  const html = new TextDecoder().decode(page.body);
  if (!pageIsBrand(html)) return null;
  for (const c of iconCandidates(html, page.url).slice(0, 4)) {
    if (!robotsAllows(robotsText, new URL(c.url).pathname)) continue;
    const img = await politeFetch(ctx, c.url, "image/png,image/svg+xml,image/*", MAX_LOGO_BYTES).catch(() => null);
    if (!img) continue;
    const sniffed = sniffImage(img.body);
    if (!sniffed) continue;
    if (sniffed.type !== "image/svg+xml" && Math.min(sniffed.width ?? 0, sniffed.height ?? 0) < MIN_RASTER_PX) continue;
    return {
      source: "website",
      pageUrl: c.url,
      license: { license: NOMINATIVE_USE, attributionRequired: false },
      attribution: new URL(page.url).hostname.replace(/^www\./, ""),
      attributionUrl: home.origin,
      contentType: sniffed.type,
      data: img.body,
      width: sniffed.width,
      height: sniffed.height,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Image sniffing
// ---------------------------------------------------------------------------

export interface Sniffed {
  type: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/svg+xml";
  width: number | null;
  height: number | null;
}

/** Content type + pixel size from the bytes themselves (never the header). */
export function sniffImage(b: Uint8Array): Sniffed | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: "image/png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { type: "image/gif", width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (chunk === "VP8X") return { type: "image/webp", width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (chunk === "VP8 ") return { type: "image/webp", width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = dv.getUint32(21, true);
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { type: "image/webp", width: null, height: null };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "image/jpeg", height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + len;
    }
    return { type: "image/jpeg", width: null, height: null };
  }
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 4096))).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg\b/i.test(head)) {
    const text = new TextDecoder().decode(b);
    if (!isSafeSvg(text)) return null;
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
    return { type: "image/svg+xml", width: vb ? Math.round(Number(vb[1])) : null, height: vb ? Math.round(Number(vb[2])) : null };
  }
  return null;
}

/** SVG with no scripting, event handlers, foreign content or external refs. */
export function isSafeSvg(svg: string): boolean {
  if (/<script\b|<foreignObject\b|javascript:|\son[a-z]+\s*=/i.test(svg)) return false;
  if (/(?:xlink:)?href\s*=\s*["'](?!#|data:image\/(?:png|jpeg|gif|webp);)/i.test(svg)) return false;
  if (/@import|url\(\s*["']?(?!#)/i.test(svg)) return false;
  return true;
}

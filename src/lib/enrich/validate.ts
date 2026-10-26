import { parseModelJson } from "@/lib/ai/json";
import { isValidLeaf, WEDGE_IDS } from "@/lib/flavor-wheel";
import { cleanProfile } from "@/lib/ingest/enrich";
import { isValidWedgeProfile } from "@/lib/ingest/flavor-tiers";

/**
 * Validation for model replies in enrichment (src/lib/enrich/queue.ts).
 * Everything a model returns is parsed and bounded here before it is written
 * or shown; nothing is trusted because of where it came from.
 */

export type WedgeProfile = Record<string, number>;

/** A bounded, single-line plain-text phrase, or null. */
export function cleanPhrase(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 2) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** First JSON object/array in a model reply that holds a profile for `bottleId`. */
export function parseQuickResult(raw: string, bottleId: string): WedgeProfile | null {
  const parsed = parseModelJson(raw);
  const entries = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, profile } = entry as { id?: unknown; profile?: unknown };
    // A single-bottle prompt; an entry naming a different id is not ours.
    if (id !== undefined && id !== bottleId) continue;
    const clean = cleanProfile(profile);
    if (clean && isValidWedgeProfile(clean)) return clean;
  }
  return null;
}

export interface WebSource {
  url: string;
  label: string;
}

export interface WebDetails {
  abv?: number;
  ageYears?: number;
  caskTypes?: string[];
  mashBill?: string;
  country?: string;
}

export interface WebResult {
  profile: WedgeProfile | null;
  notes: { nose: string | null; palate: string | null; finish: string | null; leaves: string[] } | null;
  details: WebDetails;
  sources: WebSource[];
}

/** Countries as the catalog spells them; anything else is left for review. */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "USA",
  "united states": "USA",
  "united states of america": "USA",
  us: "USA",
  scotland: "Scotland",
  ireland: "Ireland",
  "northern ireland": "Ireland",
  japan: "Japan",
  canada: "Canada",
  india: "India",
  taiwan: "Taiwan",
  england: "England",
  wales: "Wales",
  australia: "Australia",
  france: "France",
  germany: "Germany",
  sweden: "Sweden",
  netherlands: "Netherlands",
  "south africa": "South Africa",
  israel: "Israel",
};

export function cleanSources(value: unknown, max = 6): WebSource[] {
  if (!Array.isArray(value)) return [];
  const out: WebSource[] = [];
  const hosts = new Set<string>();
  for (const item of value) {
    const rawUrl = typeof item === "string" ? item : (item as { url?: unknown })?.url;
    if (typeof rawUrl !== "string" || rawUrl.length > 500) continue;
    let url: URL;
    try {
      url = new URL(rawUrl.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    const host = url.hostname.toLowerCase();
    // Public web pages only: no bare IPs, no single-label or local hosts.
    if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.endsWith(".local") || host === "localhost") continue;
    if (hosts.has(host)) continue;
    hosts.add(host);
    const label = cleanPhrase((item as { label?: unknown })?.label, 60) ?? host.replace(/^www\./, "");
    out.push({ url: url.toString(), label });
    if (out.length >= max) break;
  }
  return out;
}

export function cleanDetails(value: unknown): WebDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const details: WebDetails = {};
  const abv = typeof v.abv === "number" ? v.abv : Number(v.abv);
  if (Number.isFinite(abv) && abv >= 30 && abv <= 80) details.abv = Math.round(abv * 10) / 10;
  const age = typeof v.ageYears === "number" ? v.ageYears : Number(v.ageYears);
  if (Number.isInteger(age) && age >= 1 && age <= 60) details.ageYears = age;
  if (Array.isArray(v.caskTypes)) {
    const casks = v.caskTypes.map((c) => cleanPhrase(c, 40)).filter((c): c is string => !!c).slice(0, 4);
    if (casks.length > 0) details.caskTypes = casks;
  }
  const mash = cleanPhrase(v.mashBill, 120);
  if (mash) details.mashBill = mash;
  if (typeof v.country === "string") {
    const country = COUNTRY_ALIASES[v.country.trim().toLowerCase()];
    if (country) details.country = country;
  }
  return details;
}

/**
 * The web step's reply. Notes and details are kept only when the reply cites
 * at least one public source — the product never presents an unsourced model
 * guess as published tasting notes (AGENTS.md: AI never invents specifics).
 */
export function parseWebResult(raw: string): WebResult | null {
  const parsed = parseModelJson(raw);
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof obj !== "object" || obj === null) return null;
  const v = obj as Record<string, unknown>;
  const cleaned = cleanProfile(v.profile);
  const profile = cleaned && isValidWedgeProfile(cleaned) ? cleaned : null;
  const sources = cleanSources(v.sources);
  let notes: WebResult["notes"] = null;
  let details: WebDetails = {};
  if (sources.length > 0) {
    const n = (typeof v.notes === "object" && v.notes !== null ? v.notes : {}) as Record<string, unknown>;
    const leaves = Array.isArray(v.leaves)
      ? [...new Set(v.leaves.filter((l): l is string => typeof l === "string" && isValidLeaf(l)))].slice(0, 12)
      : [];
    const candidate = { nose: cleanPhrase(n.nose), palate: cleanPhrase(n.palate), finish: cleanPhrase(n.finish), leaves };
    if (candidate.nose || candidate.palate || candidate.finish || leaves.length > 0) notes = candidate;
    details = cleanDetails(v.details);
  }
  if (!profile && !notes && Object.keys(details).length === 0) return null;
  return { profile, notes, details, sources };
}

/** "Sweet, woody and spicy lead" — the top wedges of a profile, for an event line. */
export function profileHeadline(profile: WedgeProfile): string {
  const top = WEDGE_IDS.filter((w) => (profile[w] ?? 0) > 0)
    .sort((a, b) => (profile[b] ?? 0) - (profile[a] ?? 0))
    .slice(0, 3);
  if (top.length === 0) return "";
  const words = top.map((w) => w);
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return `${list[0].toUpperCase()}${list.slice(1)} lead`;
}

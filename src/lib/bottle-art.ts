import catalogSources from "../../config/catalog-sources.json";

/**
 * Bottle imagery policy (owner feedback 2026-10-26: "bottle pictures would
 * help"). docs/DATA_SOURCES.md §2.4: only `display_remote` media may render,
 * with attribution; `link_only` / `review_required` media never render. The
 * catalog only ever copies `display_remote` media into `bottles.image_url`,
 * and on top of that a URL renders only when its host belongs to a source
 * whose policy is `display_remote` — the same list next.config.ts hands to
 * the image optimizer as `remotePatterns`, so nothing is hotlinked from a
 * host that hasn't granted it. Everything else gets the generated silhouette.
 */
type SourceEntry = { baseUrl?: string; mediaPolicy?: string; mediaHosts?: string[] };

export function displayImageHosts(sources: SourceEntry[] = (catalogSources as { sources: SourceEntry[] }).sources): string[] {
  const hosts = new Set<string>();
  for (const s of sources) {
    if (s.mediaPolicy !== "display_remote") continue;
    for (const raw of [s.baseUrl, ...(s.mediaHosts ?? [])]) {
      if (!raw) continue;
      try {
        hosts.add(new URL(raw.includes("://") ? raw : `https://${raw}`).hostname);
      } catch {}
    }
  }
  return [...hosts].sort();
}

/** The remote image to show for a bottle, or null for the silhouette. */
export function displayableImage(url: string | null | undefined, hosts: string[] = displayImageHosts()): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return hosts.includes(parsed.hostname) ? url : null;
  } catch {
    return null;
  }
}

export type BottleShape = "squat" | "tall" | "square" | "flask";

/** A silhouette family per style — a bourbon's broad shoulders, a malt's tall neck. */
export function bottleShape(category: string): BottleShape {
  switch (category) {
    case "bourbon":
    case "rye":
    case "american-other":
    case "american-single-malt":
      return "squat";
    case "japanese":
      return "square";
    case "canadian":
      return "flask";
    default:
      return "tall";
  }
}

/**
 * Liquid tint by cask first (the name says "sherry", "port", "peated"), then
 * by region (Islay reads smoky), then by style. Colours sit in the Ledger ×
 * Paper amber range so a shelf of them looks like one set.
 */
export function liquidTint(input: { name: string; category: string; region?: string | null }): string {
  const n = input.name.toLowerCase();
  if (/\b(sherry|oloroso|pedro xim|px)\b/.test(n)) return "#7a3420";
  if (/\b(port|ruby|wine cask|madeira|sauternes)\b/.test(n)) return "#7c2a3a";
  if (/\b(peat|peated|smok)/.test(n) || input.region === "Islay") return "#8b7340";
  if (/\b(rum|cognac)\b/.test(n)) return "#9a4f22";
  switch (input.category) {
    case "bourbon":
      return "#b4602a";
    case "rye":
      return "#a54f2c";
    case "irish":
      return "#c99a3e";
    case "japanese":
      return "#c58a3c";
    case "canadian":
      return "#c5913f";
    case "scotch-blended":
      return "#b97f36";
    default:
      return "#b0763a";
  }
}

/** One or two letters for a monogram: "Buffalo Trace" → "BT", "Lagavulin" → "L". */
export function monogram(name: string | null | undefined): string {
  const words = (name ?? "")
    .replace(/\b(distillery|distilling|company|co\.?|the|and|&|whiskey|whisky)\b/gi, " ")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0][0]!.toUpperCase();
  return (words[0][0]! + words[1][0]!).toUpperCase();
}

/**
 * Monogram roundel colour by region/style family — a quiet cue of where a
 * brand is from, not a logo. Distinct hues, all readable under light text.
 */
export function monogramColor(input: { category: string; region?: string | null; country?: string | null }): string {
  if (input.region === "Islay") return "#4f5d46";
  if (input.region === "Speyside") return "#6b4a2e";
  if (input.region === "Highland" || input.region === "Highlands") return "#55473a";
  switch (input.category) {
    case "bourbon":
      return "#7a3f1f";
    case "rye":
      return "#6e3424";
    case "american-single-malt":
    case "american-other":
      return "#6a4526";
    case "scotch-single-malt":
      return "#4e4a37";
    case "scotch-blended":
      return "#5b4a30";
    case "irish":
      return "#3f5a3c";
    case "japanese":
      return "#5a3a3f";
    case "canadian":
      return "#5c3b2a";
    default:
      return "#4c4438";
  }
}

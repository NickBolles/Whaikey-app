/** Tag rules shared by the pour sheet and the server (no database imports). */

/** Most tags one pour can carry, and the longest a tag may be. */
export const MAX_TAGS_PER_POUR = 10;
export const MAX_TAG_LENGTH = 32;

/**
 * "  #Tasting   Night " → "Tasting Night". Null when nothing is left. A tag
 * is a label, not a sentence: one leading # is dropped, inner whitespace
 * collapses, and it is cut to MAX_TAG_LENGTH.
 */
export function cleanTag(raw: string): string | null {
  const cleaned = raw.replace(/^\s*#/, "").replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** The identity of a tag: "Gift" and "gift" are the same one. */
export function tagKey(name: string): string {
  return name.toLowerCase();
}

/** Cleaned, de-duplicated (by key, first spelling wins), capped. */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const name = cleanTag(r);
    if (!name) continue;
    const key = tagKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_TAGS_PER_POUR) break;
  }
  return out;
}

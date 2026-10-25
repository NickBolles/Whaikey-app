/**
 * Label text → catalog bottle, without an AI call (M1 / Track A5).
 *
 * The first pass of a label scan runs on the phone: iOS Vision or Android
 * ML Kit reads the text off the photo for free (src/lib/native/ocr.ts), and
 * this module turns those lines into catalog candidates with a confidence.
 * Only when the confidence is below `LABEL_MATCH_THRESHOLD` does the client
 * fall back to the paid AI vision read (`/api/scan-label`).
 *
 * Two halves:
 *
 * - **Pure** (`parseLabelText`, `scoreCandidate`, `rankCandidates`): OCR lines
 *   → signals (distinctive words weighted by how large they were printed, age
 *   statement, ABV/proof, vintage, cask words) → a 0–1 score per catalog
 *   bottle. Tolerates OCR damage: "GLENFIDDLCH", "l2 YEARS", "43 % vol",
 *   "GLEN FIDDICH" all still meet "Glenfiddich 12 Year Old".
 * - **Retrieval** (`matchLabelText`): a handful of bounded `searchBottles`
 *   queries built from the most prominent words, unioned and re-ranked with
 *   the pure scorer.
 *
 * The scorer measures how much of the *candidate's* name the label explains,
 * not how much of the label the name explains — a label is mostly boilerplate
 * ("distilled and bottled by…", the government warning), a name is not.
 */
import type { DB } from "@/db";
import { searchBottles, type BottleSearchResult } from "@/lib/search";

/** One recognized line. `height` is the glyph height as a fraction of the image height, when the engine gives one. */
export interface OcrLine {
  text: string;
  height?: number;
  confidence?: number;
}

export interface LabelSignals {
  /** Distinctive tokens, most prominent first, de-duplicated. */
  tokens: string[];
  /** Prominence weight per token (1 = the largest print on the label). */
  weights: Record<string, number>;
  /** All normalized text with spaces removed, for split/merged-word matching. */
  squashed: string;
  ageYears: number | null;
  abv: number | null;
  vintage: number | null;
  caskWords: string[];
}

export interface ScoredCandidate extends BottleSearchResult {
  score: number;
}

export interface LabelMatchResult {
  signals: LabelSignals;
  candidates: ScoredCandidate[];
  /** 0–1: the top score, discounted when the runner-up is close. */
  confidence: number;
  /** True when the on-device read is good enough to skip the AI call. */
  confident: boolean;
}

/** At or above this the client shows the OCR candidates and does not call the AI read. Tuned on `label-match.fixtures.ts`. */
export const LABEL_MATCH_THRESHOLD = 0.7;
/** A runner-up closer than this to the top answer costs the top answer confidence. */
export const LABEL_MATCH_MARGIN = 0.08;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Words every label (or every bottle name) carries. They still count when a
 * candidate's name contains them, at a fraction of the weight: "Buffalo Trace
 * Kentucky Straight Bourbon" is identified by "buffalo trace", not by "bourbon".
 */
const GENERIC = new Set([
  "whisky", "whiskey", "whiskies", "bourbon", "scotch", "single", "malt", "grain", "blended", "blend",
  "straight", "kentucky", "tennessee", "irish", "japanese", "canadian", "american", "highland", "speyside",
  "islay", "lowland", "campbeltown", "rye", "wheat", "corn", "pot", "still", "cask", "casks", "barrel",
  "barrels", "strength", "proof", "edition", "reserve", "special", "select", "selection", "original",
  "classic", "old", "year", "years", "aged", "finish", "finished", "matured", "batch", "small", "limited",
  "release", "bottled", "bond", "distillery", "distilling", "distillers", "distilled", "company", "co",
  "the", "of", "and", "de", "la", "le", "no", "by", "in", "oak", "fine", "rare",
]);

/** Pure boilerplate: never a name token, never a query term. */
const BOILERPLATE = new Set([
  "government", "warning", "surgeon", "general", "women", "pregnancy", "pregnant", "birth", "defects",
  "drive", "machinery", "health", "problems", "consumption", "alcoholic", "beverages", "impairs", "ability",
  "according", "should", "not", "drink", "during", "risk", "your", "car", "operate", "may", "cause",
  "product", "produce", "produced", "imported", "importer", "importers", "bottler", "contains", "sulfites",
  "alc", "vol", "abv", "ml", "cl", "ltr", "litre", "liter", "l", "e", "www", "com", "est", "established",
  "since", "founded", "usa", "scotland", "ireland", "japan", "canada", "uk", "us", "made", "for", "from",
  "with", "a", "an", "to", "is", "at", "on", "this", "that", "our", "its", "it", "be", "are", "was",
  "enjoy", "responsibly", "please", "recycle", "deposit", "ky", "tn", "louisville", "frankfort",
]);

/** Cask/finish vocabulary worth surfacing as its own signal. */
const CASK_PHRASES = [
  "sherry", "oloroso", "pedro ximenez", "px", "port", "madeira", "sauternes", "rum", "cognac", "wine",
  "virgin oak", "double oak", "double oaked", "toasted", "cask strength", "barrel proof", "single barrel",
  "small batch", "bottled in bond", "full proof", "peated", "unpeated",
];

function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Undo the OCR confusions that matter for numbers: "l2" → "12", "4O%" → "40%",
 * "S0 PROOF" left alone (S is a real letter often enough). Only touches
 * characters flanked by digits, so words are not rewritten.
 */
function fixDigitConfusions(s: string): string {
  return s
    .replace(/(?<=\d)[oO](?=\d|\s*%|\b)/g, "0")
    .replace(/\b[lI|](?=\d)/g, "1")
    .replace(/(?<=\d)[lI|](?=\d)/g, "1");
}

export function normalizeLabelLine(s: string): string {
  return fixDigitConfusions(stripDiacritics(s))
    .toLowerCase()
    .replace(/[’'`´]/g, "")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[^a-z0-9.%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Word tokens of a normalized string (periods dropped except inside numbers). */
export function wordTokens(s: string): string[] {
  return s
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .split(/[\s%]+/)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

const AGE_RE =
  /\b(\d{1,2})\s*(?:-\s*)?(?:years?|yrs?|yo|y\s?o|ans|jahre|anos|year\s+old|years\s+old)\b|\baged\s+(\d{1,2})\b/;
const ABV_RE = /\b(\d{2}(?:\.\d{1,2})?)\s*%/;
const ABV_WORD_RE = /\b(?:alc|abv)\s*(\d{2}(?:\.\d{1,2})?)\b/;
const PROOF_RE = /\b(\d{2,3}(?:\.\d)?)\s*(?:proof|us\s+proof)\b/;
const YEAR_RE = /\b(?:(est|established|since|founded|anno)\s*)?(19[4-9]\d|20[0-3]\d)\b/g;

function parseAge(text: string): number | null {
  const m = AGE_RE.exec(text);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isFinite(n) && n >= 2 && n <= 60 ? n : null;
}

function parseAbv(text: string): number | null {
  for (const re of [ABV_RE, ABV_WORD_RE]) {
    const m = re.exec(text);
    const n = m ? Number(m[1]) : NaN;
    if (Number.isFinite(n) && n >= 35 && n <= 75) return n;
  }
  const p = PROOF_RE.exec(text);
  const proof = p ? Number(p[1]) : NaN;
  if (Number.isFinite(proof) && proof >= 70 && proof <= 150) return Math.round((proof / 2) * 10) / 10;
  return null;
}

function parseVintage(text: string): number | null {
  for (const m of text.matchAll(YEAR_RE)) {
    if (m[1]) continue; // "est. 1870" is the distillery, not the whisky
    return Number(m[2]);
  }
  return null;
}

function isNoiseToken(t: string): boolean {
  if (t.length < 2) return true;
  if (BOILERPLATE.has(t)) return true;
  if (/^\d+(\.\d+)?$/.test(t)) return true; // numbers are read as age/abv/vintage
  if (/^\d+(ml|cl|l)$/.test(t)) return true;
  // OCR garbage: no vowels in a long token, or mostly digits mixed with letters.
  if (t.length >= 4 && !/[aeiouy]/.test(t)) return true;
  if (/\d/.test(t) && /[a-z]/.test(t) && !/^\d+(yr|yo|y)$/.test(t)) return true;
  return false;
}

/**
 * OCR lines → signals. Accepts the engine's lines (with optional heights) or a
 * plain block of text. Lines printed larger weigh more: the brand is almost
 * always the biggest thing on a label and the warning the smallest.
 */
export function parseLabelText(input: OcrLine[] | string): LabelSignals {
  const lines: OcrLine[] =
    typeof input === "string" ? input.split(/\r?\n/).map((text) => ({ text })) : input;
  const normalized = lines
    .map((l) => ({ text: normalizeLabelLine(l.text ?? ""), height: l.height, confidence: l.confidence }))
    .filter((l) => l.text.length > 0);
  const all = normalized.map((l) => l.text).join(" \n ");

  const heights = normalized.map((l) => l.height).filter((h): h is number => typeof h === "number" && h > 0);
  const maxHeight = heights.length > 0 ? Math.max(...heights) : null;

  const weights: Record<string, number> = {};
  const order: string[] = [];
  normalized.forEach((line, index) => {
    // Without heights, earlier lines (top of the label) get a mild preference.
    const prominence =
      maxHeight && line.height
        ? Math.max(0.15, line.height / maxHeight)
        : Math.max(0.4, 1 - index * 0.06);
    const confidence = typeof line.confidence === "number" ? Math.max(0.3, Math.min(1, line.confidence)) : 1;
    for (const t of wordTokens(line.text)) {
      if (isNoiseToken(t)) continue;
      const w = prominence * confidence;
      if (!(t in weights)) order.push(t);
      weights[t] = Math.max(weights[t] ?? 0, w);
    }
  });
  const tokens = order.sort((a, b) => weights[b] - weights[a] || order.indexOf(a) - order.indexOf(b));

  const flat = all.replace(/\n/g, " ");
  const caskWords = CASK_PHRASES.filter((p) => new RegExp(`\\b${p}\\b`).test(flat));

  return {
    tokens,
    weights,
    squashed: flat.replace(/[^a-z0-9]/g, ""),
    ageYears: parseAge(flat),
    abv: parseAbv(flat),
    vintage: parseVintage(flat),
    caskWords,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Plain Levenshtein distance, bounded by the caller to short tokens. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * How well one name token is present in the label, 0–1. Exact beats fuzzy;
 * fuzzy needs a long enough token for an edit to be a typo rather than a
 * different word ("rare" vs "care" must not meet).
 */
export function tokenPresence(nameToken: string, signals: LabelSignals): number {
  if (signals.weights[nameToken] !== undefined) return 1;
  let best = 0;
  if (nameToken.length >= 5) {
    const allowed = nameToken.length >= 8 ? 2 : 1;
    for (const t of signals.tokens) {
      if (Math.abs(t.length - nameToken.length) > allowed) continue;
      const d = editDistance(nameToken, t);
      if (d <= allowed) best = Math.max(best, 1 - d / (nameToken.length + 1));
    }
  }
  // "GLEN FIDDICH" on two lines, or "BUFFALOTRACE" read as one word.
  if (best < 0.85 && nameToken.length >= 5 && signals.squashed.includes(nameToken)) best = Math.max(best, 0.85);
  return best;
}

function nameTokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return wordTokens(normalizeLabelLine(s)).filter(
    (t) => !BOILERPLATE.has(t) && !/^\d+(yr|yo|y)?$/.test(t) && t.length >= 2,
  );
}

/** Numbers in a name that are not its age ("Wild Turkey 101", "Four Roses Single Barrel OESO"). */
function nameNumbers(name: string, ageYears: number | null): string[] {
  const out: string[] = [];
  for (const m of normalizeLabelLine(name).matchAll(/\b(\d{2,4})\b/g)) {
    const n = Number(m[1]);
    if (ageYears != null && n === ageYears) continue;
    out.push(m[1]);
  }
  return out;
}

/**
 * Score one catalog candidate against the label, 0–1.
 *
 * - coverage: weighted share of the candidate's name tokens present on the
 *   label (generic words at 0.25)
 * - distillery: share of the distillery's tokens present (when the name does
 *   not already contain it)
 * - age / ABV agreement: a matching age is strong evidence, a contradicting
 *   one is near-disqualifying (Glenfiddich 12 vs 18 share every word)
 * - non-age numbers in the name ("101") must appear on the label
 */
export function scoreCandidate(signals: LabelSignals, candidate: BottleSearchResult): number {
  const tokens = [...new Set(nameTokens(candidate.name))];
  if (tokens.length === 0) return 0;
  let num = 0;
  let den = 0;
  let distinctiveHits = 0;
  for (const t of tokens) {
    const w = GENERIC.has(t) ? 0.25 : 1;
    const p = tokenPresence(t, signals);
    num += w * p;
    den += w;
    if (w === 1 && p >= 0.75) distinctiveHits++;
  }
  // A name made only of generic words ("Single Malt 12") cannot be identified by words.
  if (distinctiveHits === 0) return Math.min(0.3, (num / den) * 0.3);
  const coverage = num / den;

  const nameSet = new Set(tokens);
  const distTokens = nameTokens(candidate.distillery).filter((t) => !nameSet.has(t) && !GENERIC.has(t));
  const distillery =
    distTokens.length > 0
      ? distTokens.reduce((s, t) => s + tokenPresence(t, signals), 0) / distTokens.length
      : null;

  let score = distillery == null ? coverage : 0.8 * coverage + 0.2 * Math.max(distillery, coverage * 0.5);

  const age = candidate.ageYears ?? null;
  if (age != null && signals.ageYears != null) score += age === signals.ageYears ? 0.15 : -0.4;
  else if (age == null && signals.ageYears != null) score -= 0.12;
  else if (age != null && signals.ageYears == null) score -= 0.08;

  if (candidate.abv != null && signals.abv != null) {
    const diff = Math.abs(candidate.abv - signals.abv);
    if (diff <= 0.6) score += 0.08;
    else if (diff > 1.6) score -= 0.15;
  }

  for (const n of nameNumbers(candidate.name, age)) {
    if (!signals.squashed.includes(n)) score -= 0.25;
  }

  return Math.max(0, Math.min(1, score));
}

/** Score, sort and summarize candidates. Pure, so the eval and the route share it. */
export function rankCandidates(
  signals: LabelSignals,
  candidates: BottleSearchResult[],
  limit = 3,
): Omit<LabelMatchResult, "signals"> {
  const seen = new Set<string>();
  const scored: ScoredCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    scored.push({ ...c, score: Math.round(scoreCandidate(signals, c) * 1000) / 1000 });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = scored[0]?.score ?? 0;
  const second = scored[1]?.score ?? 0;
  const confidence = Math.max(0, top - Math.max(0, LABEL_MATCH_MARGIN - (top - second)));
  const kept = scored.filter((c) => c.score >= 0.35).slice(0, limit);
  return {
    candidates: kept,
    confidence: Math.round(confidence * 1000) / 1000,
    confident: kept.length > 0 && confidence >= LABEL_MATCH_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

const MAX_QUERIES = 6;
const PER_QUERY = 8;

/** The bounded set of catalog queries a label produces, most specific first. */
export function labelQueries(signals: LabelSignals): string[] {
  const distinctive = signals.tokens.filter((t) => !GENERIC.has(t) && t.length >= 3);
  const queries: string[] = [];
  const push = (q: string) => {
    const trimmed = q.trim();
    if (trimmed.length >= 3 && !queries.includes(trimmed)) queries.push(trimmed);
  };
  if (distinctive.length >= 2) push(distinctive.slice(0, 2).join(" "));
  if (distinctive.length >= 3) push(distinctive.slice(0, 3).join(" "));
  if (distinctive.length >= 2 && signals.ageYears) push(`${distinctive.slice(0, 2).join(" ")} ${signals.ageYears}`);
  for (const t of distinctive.slice(0, 4)) push(t);
  return queries.slice(0, MAX_QUERIES);
}

/**
 * Match recognized label text against the catalog the viewer can see. A few
 * `searchBottles` calls (trigram-indexed), so the cost stays flat as the
 * catalog grows; never throws on an empty or garbage read.
 */
export async function matchLabelText(
  db: DB,
  input: OcrLine[] | string,
  opts: { viewerId?: string; limit?: number } = {},
): Promise<LabelMatchResult> {
  const signals = parseLabelText(input);
  const queries = labelQueries(signals);
  const pool: BottleSearchResult[] = [];
  for (const q of queries) {
    pool.push(...(await searchBottles(db, q, { limit: PER_QUERY, viewerId: opts.viewerId })));
  }
  return { signals, ...rankCandidates(signals, pool, opts.limit ?? 3) };
}

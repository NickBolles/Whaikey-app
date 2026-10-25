/**
 * The label-photo pipeline, client side (M1 / Track A5): free on-device OCR
 * first, paid AI vision only when that is not confident.
 *
 *   photo ─▶ recognizeLabelText (Vision / ML Kit, on the phone)
 *         ─▶ POST /api/scan/label-text  ── confident ──▶ candidates (via "ocr")
 *                                       └─ not ──▶ POST /api/scan-label (AI) ─▶ candidates (via "ai")
 *
 * On the web there is no on-device engine, so the first step is skipped and
 * this is exactly the old AI-only flow. If the AI read is unavailable
 * (503 unconfigured / 429 budget), whatever the on-device read found is
 * still offered rather than nothing.
 *
 * Client-safe: no DB or server imports; `fetch` and the recognizer are
 * injectable for tests.
 */
import type { BottleSearchResult } from "@/lib/ai/tools";
import { recognizeLabelText, type OcrResult } from "@/lib/native/ocr";

export type LabelVia = "ocr" | "ai";

export interface LabelScanOutcome {
  via: LabelVia;
  candidates: BottleSearchResult[];
  /** What the label appears to say, for the review sheet subtitle. */
  guess: string | null;
  /** Set when the AI read was wanted but unavailable. */
  aiUnavailable: "unconfigured" | "limited" | null;
}

export interface LabelScanDeps {
  fetch?: typeof fetch;
  recognize?: (dataUrl: string) => Promise<OcrResult | null>;
}

const post = (f: typeof fetch, url: string, body: unknown) =>
  f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The two most prominent lines (largest print), in label order. */
export function ocrGuess(ocr: OcrResult): string | null {
  const ranked = ocr.lines
    .map((l, i) => ({ ...l, i }))
    .filter((l) => /[a-z]{3}/i.test(l.text))
    .sort((a, b) => (b.height ?? 1 - b.i * 0.01) - (a.height ?? 1 - a.i * 0.01))
    .slice(0, 2)
    .sort((a, b) => a.i - b.i);
  const text = ranked.map((l) => l.text).join(" ").trim();
  return text ? text.slice(0, 80) : null;
}

export async function identifyLabel(
  dataUrl: string,
  mediaType: string,
  deps: LabelScanDeps = {},
): Promise<LabelScanOutcome> {
  const f = deps.fetch ?? fetch;
  const recognize = deps.recognize ?? recognizeLabelText;

  let ocrCandidates: BottleSearchResult[] = [];
  let ocrText: string | null = null;
  const ocr = await recognize(dataUrl).catch(() => null);
  if (ocr) {
    ocrText = ocrGuess(ocr);
    try {
      const res = await post(f, "/api/scan/label-text", { lines: ocr.lines, engine: ocr.engine });
      if (res.ok) {
        const data = (await res.json()) as { candidates: BottleSearchResult[]; confident: boolean };
        if (data.confident && data.candidates.length > 0) {
          return { via: "ocr", candidates: data.candidates, guess: ocrText, aiUnavailable: null };
        }
        ocrCandidates = data.candidates ?? [];
      }
    } catch {
      // The free pass failing is never fatal: fall through to the AI read.
    }
  }

  const base64 = dataUrl.split(",", 2)[1] ?? dataUrl;
  let res: Response;
  try {
    res = await post(f, "/api/scan-label", { imageBase64: base64, mediaType });
  } catch (err) {
    // A dropped connection on the AI read must not throw away the choices
    // the free OCR pass already found; the person can still pick one.
    if (ocrCandidates.length > 0) return { via: "ocr", candidates: ocrCandidates, guess: ocrText, aiUnavailable: null };
    throw err;
  }
  if (res.status === 503 || res.status === 429) {
    return {
      via: "ocr",
      candidates: ocrCandidates,
      guess: ocrText,
      aiUnavailable: res.status === 503 ? "unconfigured" : "limited",
    };
  }
  if (!res.ok) {
    if (ocrCandidates.length > 0) return { via: "ocr", candidates: ocrCandidates, guess: ocrText, aiUnavailable: null };
    throw new Error(`label scan failed (${res.status})`);
  }
  const data = (await res.json()) as {
    extracted: { brandGuess: string | null; expressionGuess: string | null };
    candidates: BottleSearchResult[];
  };
  const guess = [data.extracted.brandGuess, data.extracted.expressionGuess].filter(Boolean).join(" ") || ocrText;
  const seen = new Set(data.candidates.map((c) => c.id));
  const candidates = [...data.candidates, ...ocrCandidates.filter((c) => !seen.has(c.id))].slice(0, 4);
  return { via: "ai", candidates, guess, aiUnavailable: null };
}

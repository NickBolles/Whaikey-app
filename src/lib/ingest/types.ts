import type { WhiskeyCategory } from "@/db/schema";

/**
 * A normalized catalog row produced by a source adapter (Iowa, TTB COLA, …)
 * before it is matched against — and possibly inserted into — the bottles
 * table. Adapters do all source-specific parsing; the shared ingest core only
 * sees this shape.
 */
export interface CatalogCandidate {
  /** Cleaned display name, e.g. "Wayne Gretzky No. 99 Red Cask". */
  name: string;
  category: WhiskeyCategory;
  /** Data source tag, recorded in the ingest report and UPC rows. */
  source: "iowa" | "cola" | "oregon" | "utah" | "bc" | "systembolaget" | "vinmonopolet";
  /**
   * Normalized English country name ("Scotland", "USA"), when the source
   * states one. Adapters translate source vocabularies (Swedish names,
   * "United States" variants) before it lands here; the shared insert path
   * falls back to `categoryCountry()` for geographically defined categories.
   */
  country?: string;
  /** Sub-national origin only (see bottles.region) — never a country. */
  region?: string;
  ageYears?: number | null;
  abv?: number | null;
  /** Typical 750ml retail price when the source provides one. */
  avgPrice?: number | null;
  /** Normalized, check-digit-valid GTINs. */
  upcs?: string[];
}

export interface IngestReport {
  source: string;
  /** Source rows seen before any filtering. */
  scanned: number;
  /** Candidates produced after filtering/dedupe. */
  candidates: number;
  /** Candidates that matched an existing bottle (by id, name, or alias). */
  matchedExisting: number;
  /** New bottles inserted (status "imported"). */
  inserted: number;
  /** New UPC mappings attached (to both new and existing bottles). */
  upcsAdded: number;
  /** True when the run made no writes. */
  dryRun: boolean;
}

/**
 * The source answered, but not with its data: a parked domain, a maintenance
 * page, a login wall, an HTML error page served with HTTP 200.
 *
 * Separate from a plain `Error` because the right response is different. A
 * parser bug or a schema change in OUR code should fail the sync loudly; a
 * third party taking its API offline is not something a rerun or a code fix
 * on our side can repair, so the CLI reports the source as `degraded`, the
 * workflow stays green-with-warning and opens an issue, and the rest of the
 * catalog keeps syncing. A review API's domain lapsing into a STRATO
 * "Domain not available" page is the case that motivated it: seven weekly
 * runs went red for a reason nobody on this side could change.
 */
export class SourceUnavailableError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

/**
 * Read a JSON body, or explain what came back instead.
 *
 * `res.json()` on an HTML page throws `Unexpected token '<'`, which names
 * neither the source nor what the page was. This checks the content type and
 * the first byte, and puts the page's <title> into the message, so the log
 * says "<source> returned HTML (STRATO - Domain not available)".
 */
export async function readJsonResponse(res: Response, source: string, url: string): Promise<unknown> {
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  const trimmed = text.trimStart();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksJson || /text\/html/i.test(type)) {
    const title = trimmed.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    const what = /<html|<!doctype/i.test(trimmed.slice(0, 200)) ? "HTML" : `non-JSON (${type || "no content type"})`;
    throw new SourceUnavailableError(
      source,
      `${source} returned ${what} instead of JSON from ${url}${title ? ` (${title})` : ""}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SourceUnavailableError(source, `${source} returned malformed JSON from ${url}: ${(err as Error).message}`);
  }
}

/**
 * `fetch` that reports an unreachable host as SourceUnavailableError.
 *
 * When a third party's domain lapses, what we get back drifts over time: first
 * a parking page with HTTP 200 (handled by readJsonResponse), then nothing at
 * all — DNS stops resolving, or the parked host refuses the TLS handshake.
 * The (since removed) WHISKY:EDITION source reached that stage in Oct 2026 (`fetch failed` with
 * ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE) and turned the weekly sync red
 * again. undici rejects with a TypeError("fetch failed") whose `cause` carries
 * the code; that is the third party being gone, not a bug on our side, so it
 * is reported as degraded. Anything else (an AbortError, a bug in a mock)
 * propagates unchanged.
 */
export async function fetchSource(
  fetchImpl: typeof fetch,
  url: string,
  source: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
      const cause = err.cause as { code?: string; message?: string } | undefined;
      const detail = cause?.code ?? cause?.message ?? "no response";
      throw new SourceUnavailableError(source, `${source} is unreachable at ${url} (${detail})`);
    }
    throw err;
  }
}

/**
 * A ceiling on how much of a request body we are willing to hold in memory
 * (review SEC-M1 / REL-3.4).
 *
 * Next route handlers have no body limit of their own — `serverActions
 * .bodySizeLimit` only covers Server Actions — so `await request.json()`
 * buffers whatever the client sends and only then hands it to zod, which is
 * where every size check in this codebase lived. On Vercel the platform's
 * ~4.5 MB cap hid that. Self-hosted (and PLAN.md keeps that option open) one
 * authenticated 500 MB POST takes the process down.
 *
 * `Content-Length` is a claim, not a fact — it can lie, and a chunked request
 * omits it entirely — so the header is a cheap first rejection and the stream
 * is where the limit is actually enforced.
 */

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** True when the request *says* it is too big — cheap, and usually honest. */
export function declaresOversizedBody(request: Request, maxBytes: number): boolean {
  const declared = Number(request.headers.get("content-length"));
  return Number.isFinite(declared) && declared > maxBytes;
}

/**
 * Read a request body as text, stopping the moment it goes over `maxBytes`.
 *
 * Throws `BodyTooLargeError` rather than returning a sentinel so a caller can't
 * forget to check — the point of this function is that the failure is loud.
 */
export async function readTextWithinLimit(request: Request, maxBytes: number): Promise<string> {
  if (declaresOversizedBody(request, maxBytes)) throw new BodyTooLargeError(maxBytes);

  const body = request.body;
  // No stream to meter (an already-buffered body in tests, or an empty one):
  // Content-Length has had its say, so fall back and re-check what arrived.
  if (!body) {
    const text = await request.text();
    if (byteLength(text) > maxBytes) throw new BodyTooLargeError(maxBytes);
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } finally {
    // Stop the sender rather than politely draining the rest of a body we have
    // already refused.
    await reader.cancel().catch(() => {});
  }

  return new TextDecoder().decode(concat(chunks, total));
}

/**
 * Parse a JSON request body under a size limit.
 *
 * Returns `undefined` for a body that isn't JSON, matching the
 * `request.json().catch(() => null)` shape these routes already use — an
 * unparseable body is the caller's 400, an oversized one is a 413 and never
 * reaches the parser.
 */
export async function readJsonWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<unknown | undefined> {
  const text = await readTextWithinLimit(request, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

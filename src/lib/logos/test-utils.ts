import { vi } from "vitest";

/** A minimal PNG header of the given size (enough for sniffImage). */
export function pngBytes(w: number, h: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
}

/** fetch stub: URL → [status, content-type, body]. */
export function stubFetch(routes: Record<string, [number, string, string | Uint8Array]>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    if (!hit) return new Response("nope", { status: 404 });
    const [status, type, body] = hit[1];
    return new Response(body as BodyInit, { status, headers: { "content-type": type } });
  }) as unknown as typeof fetch;
}


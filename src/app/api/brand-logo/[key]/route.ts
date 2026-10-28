import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { brandLogos } from "@/db/schema";

/**
 * A brand's mark, from our own origin (docs/DATA_SOURCES.md §5.4).
 *
 * The bytes were fetched once by the backfill and live in `brand_logos`, so
 * rendering a logo never hotlinks a producer's site and never touches the
 * image optimizer's quota; Vercel's CDN keeps each one for a week. SVGs come
 * only from sanitised sources, and are still sent with a CSP that forbids
 * every kind of active content in case one is ever opened directly.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await ctx.params;
  if (!/^[a-z0-9-]{1,80}$/.test(key)) return new Response("Not found", { status: 404 });
  const [row] = await getDb()
    .select({ data: brandLogos.logoData, type: brandLogos.contentType })
    .from(brandLogos)
    .where(and(eq(brandLogos.key, key), eq(brandLogos.status, "ok")))
    .limit(1);
  if (!row?.data || !row.type || !/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(row.type)) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "public, max-age=300, s-maxage=3600" } });
  }
  const body = Buffer.from(row.data, "base64");
  return new Response(body, {
    headers: {
      "content-type": row.type,
      "content-length": String(body.byteLength),
      "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

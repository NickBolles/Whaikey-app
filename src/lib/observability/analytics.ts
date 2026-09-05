import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import type { AnalyticsEventName } from "@/db/schema";

/**
 * First-party product events — the S1 share funnel, and nothing else (WP-19).
 *
 * **No third-party analytics SDK, on the server or the client.** A pour
 * timestamp shipped to a vendor is exactly the data `docs/SOCIAL.md` says
 * never crosses a boundary, and a client SDK would carry page URLs — which on
 * `/s/<code>` means the share code, a bearer credential. So these rows are
 * written server-side, into this database, and the only identifier they hold
 * is the `pour_shares` row id: never the code.
 *
 * **Recording must not be able to break the page.** Every function here
 * swallows its own failures. A share link that 500s because telemetry could
 * not write would be the measurement destroying the thing it measures.
 */

/** Resolve a share code to its row id. The id is safe to store; the code is not. */
export async function shareIdForCode(db: DB, code: string): Promise<string | null> {
  try {
    const row = await db.query.pourShares.findFirst({
      columns: { id: true },
      where: eq(schema.pourShares.code, code),
    });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export async function recordEvent(
  db: DB,
  name: AnalyticsEventName,
  opts: { userId?: string | null; shareId?: string | null } = {},
): Promise<void> {
  try {
    await db.insert(schema.analyticsEvents).values({
      id: crypto.randomUUID(),
      name,
      userId: opts.userId ?? null,
      shareId: opts.shareId ?? null,
    });
  } catch (err) {
    console.error(`[analytics] failed to record ${name}`, err);
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { getSessionUser, withErrorHandling } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";
import { isOperator } from "@/lib/operator";
import { isValidUpc, normalizeUpc } from "@/lib/scan";
import { approvePendingBarcode, rejectBarcodeClaim } from "@/lib/upc-crowd";

export const runtime = "nodejs";

const bodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  upc: z.string().min(1).max(64),
  bottleId: z.string().min(1).max(200),
});

/**
 * POST /api/scan/claims {action: approve|reject, upc, bottleId} — operator
 * moderation of crowd barcode claims (/admin/catalog/barcodes).
 *
 * Approve publishes the mapping now, whatever the vote count. Reject stops
 * the claims counting (and against their authors' trust) and withdraws a
 * crowd-published mapping for the pair; seed/import mappings are untouched.
 * 404 for everyone who is not an operator, like the other admin endpoints.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!isOperator(user)) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const parsed = bodySchema.safeParse(await readJsonWithinLimit(request, 2048));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const upc = normalizeUpc(parsed.data.upc);
    if (!upc || !isValidUpc(upc)) return NextResponse.json({ error: "Not a valid UPC/EAN barcode" }, { status: 400 });

    const db = getDb();
    if (parsed.data.action === "approve") {
      const mapping = await approvePendingBarcode(db, upc, parsed.data.bottleId);
      if (!mapping) return NextResponse.json({ error: "No pending claim for that pair" }, { status: 404 });
      return NextResponse.json({ mapping });
    }
    const rejected = await rejectBarcodeClaim(db, upc, parsed.data.bottleId);
    if (rejected === 0) return NextResponse.json({ error: "No claim for that pair" }, { status: 404 });
    return NextResponse.json({ rejected });
  });
}

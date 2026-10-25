import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";
import { listPendingBarcodes, upcConfirmationsRequired } from "@/lib/upc-crowd";
import { BarcodeClaims } from "./barcode-claims";

export const dynamic = "force-dynamic";

/**
 * Crowd barcode claims waiting to be published (M1 "teach the scanner").
 * Claims publish themselves at the confirmation threshold; this is where an
 * operator publishes early or rejects one. `notFound()` for non-operators.
 */
export default async function AdminBarcodeClaimsPage() {
  const user = await getSessionUser();
  if (!isOperator(user)) notFound();
  const claims = await listPendingBarcodes(getDb());
  return (
    <div className="px-3 py-4 max-w-4xl mx-auto w-full flex flex-col gap-3 text-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-xl font-semibold">Barcode claims</h1>
        <nav className="flex gap-3 text-xs">
          <Link href="/admin/scan" className="text-accent hover:underline">
            Scan &amp; coverage →
          </Link>
          <Link href="/admin/submissions" className="text-accent hover:underline">
            Submissions →
          </Link>
        </nav>
      </header>
      <p className="text-xs text-muted">
        A claim publishes on its own at {upcConfirmationsRequired()} eligible confirmations (accounts older than 7
        days, not suspended) with a 2:1 lead over any competing claim. Approve to publish now; reject to withdraw it.
      </p>
      <BarcodeClaims
        claims={claims.map((c) => ({ ...c, firstAt: c.firstAt.toISOString(), lastAt: c.lastAt.toISOString() }))}
      />
    </div>
  );
}

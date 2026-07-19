import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { ScanClient } from "./scan-client";

export const dynamic = "force-dynamic";

export default async function ScanPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-6">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">🥃</div>
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Scan bottles</h1>
          <p className="text-muted mt-2 max-w-sm leading-relaxed">
            Sign in to scan a barcode or label and shelve your whole collection in minutes.
          </p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  return <ScanClient />;
}

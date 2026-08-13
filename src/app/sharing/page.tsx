import Link from "next/link";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { listPourShares } from "@/lib/pour-sharing";
import { SharedLinksList } from "./shared-links-list";

export const dynamic = "force-dynamic";

export default async function SharingPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🔗
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">Your shared links</h1>
          <p className="mt-2 max-w-sm text-muted">Sign in to see and manage the links you&apos;ve shared.</p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const shares = await listPourShares(getDb(), user.id);

  if (shares.length === 0) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🔗
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">No shared links yet</h1>
          <p className="mt-2 max-w-sm text-muted">
            Share a tasting note from your journal, and it&apos;ll show up here — revocable any time.
          </p>
        </div>
        <Link href="/history" className="btn-primary px-8 py-3">
          Go to your journal
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 pb-24 pt-8">
      <header>
        <h1 className="font-display text-[2rem] font-semibold leading-tight">Shared links</h1>
        <p className="mt-1 text-sm text-muted">
          {shares.length} active link{shares.length === 1 ? "" : "s"} · bearer links, revoke any time
        </p>
      </header>
      <SharedLinksList
        shares={shares.map((s) => ({
          code: s.code,
          pourId: s.pourId,
          bottleId: s.bottleId,
          bottleName: s.bottleName,
          createdAt: s.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}

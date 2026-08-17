import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { getBottleComparison } from "@/lib/bottle-compare";
import { CompareClient } from "./compare-client";

export const dynamic = "force-dynamic";

export default async function ComparePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-6 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">🥃</div>
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Your note, compared</h1>
          <p className="mt-2 max-w-sm leading-relaxed text-muted">
            Sign in to read your tasting note against friends, the community, and the professionals.
          </p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const comparison = await getBottleComparison(getDb(), user.id, id);
  if (!comparison) notFound();
  return <CompareClient comparison={comparison} />;
}

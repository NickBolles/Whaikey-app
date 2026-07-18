import Link from "next/link";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { listUserBottles } from "@/lib/bar";
import { BarClient } from "./bar-client";

export const dynamic = "force-dynamic";

export default async function BarPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-6">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">🥃</div>
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">My Bar</h1>
          <p className="text-muted mt-2 max-w-sm leading-relaxed">
            Sign in to track your bottles, spend, and wishlist.
          </p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const rows = await listUserBottles(getDb(), user.id);
  return <BarClient initialRows={rows} />;
}

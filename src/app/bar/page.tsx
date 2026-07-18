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
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-4">
        <div className="text-5xl">🥃</div>
        <h1 className="text-2xl font-bold">My Bar</h1>
        <p className="text-muted max-w-sm">Sign in to track your bottles, spend, and wishlist.</p>
        <Link
          href="/sign-in"
          className="rounded-xl bg-accent text-background font-semibold px-6 py-3 hover:bg-accent-deep transition-colors"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const rows = await listUserBottles(getDb(), user.id);
  return <BarClient initialRows={rows} />;
}

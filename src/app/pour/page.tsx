import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { PourFlow } from "./pour-flow";

export const dynamic = "force-dynamic";

export default async function PourPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-5">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🥃
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">The bar is open</h1>
          <p className="text-muted mt-2 max-w-sm">
            Sign in to log a pour and build your tasting journal.
          </p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }
  return <PourFlow />;
}

import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { PourFlow } from "./pour-flow";

export const dynamic = "force-dynamic";

export default async function PourPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-4">
        <div className="text-5xl">🥃</div>
        <p className="text-muted max-w-sm">Sign in to log a pour and build your tasting journal.</p>
        <Link
          href="/sign-in"
          className="rounded-xl bg-accent text-background font-semibold px-6 py-3 hover:bg-accent-deep transition-colors"
        >
          Sign in
        </Link>
      </div>
    );
  }
  return <PourFlow />;
}

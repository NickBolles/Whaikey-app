import Link from "next/link";
import { WHISKEY_CATEGORIES } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { safeReturnPath } from "@/lib/return-path";
import { NewBottleForm } from "./new-bottle-form";

export const dynamic = "force-dynamic";

type Params = Promise<{
  name?: string | string[];
  upc?: string | string[];
  source?: string | string[];
  next?: string | string[];
}>;

const first = (value?: string | string[]) => (Array.isArray(value) ? value[0] : value);

/**
 * "It's not in there" — the end of the dead end (review PLAN-A1).
 *
 * Reached from every miss: search with no results, a scan that resolves to
 * nothing, an import row with no match. It arrives pre-filled with whatever
 * the miss already knew (the query typed, the barcode read) so the user is
 * confirming rather than starting over.
 */
export default async function NewBottlePage({ searchParams }: { searchParams: Params }) {
  const user = await getSessionUser();
  const params = await searchParams;

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-5">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🥃
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">Add a bottle</h1>
          <p className="text-muted mt-2 max-w-sm">
            Sign in to add a bottle the catalog is missing.
          </p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const source = first(params.source);
  return (
    <NewBottleForm
      categories={WHISKEY_CATEGORIES}
      initialName={first(params.name) ?? ""}
      upc={first(params.upc) ?? null}
      source={
        source === "scan" || source === "search" || source === "import" ? source : "direct"
      }
      returnTo={safeReturnPath(first(params.next)) ?? null}
    />
  );
}

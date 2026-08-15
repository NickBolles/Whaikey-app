import Link from "next/link";
import { GlassWater, ScanLine, Search } from "lucide-react";

/**
 * The Home page's single accent moment: one card, one gradient action.
 * Stocked bars get "log a pour"; empty bars get "stock your bar" instead —
 * the primary action always matches the user's actual next step.
 */
export function HomeHero({ bottleCount, pourCount }: { bottleCount: number; pourCount: number }) {
  if (bottleCount === 0) {
    return (
      <section aria-label="Stock your bar" className="card p-5">
        <h2 className="font-display text-xl font-semibold">Stock your bar</h2>
        <p className="mt-1 text-sm text-muted">
          Scan a label or search the catalog to put your first bottle on the shelf.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Link
            href="/scan"
            className="btn-primary flex min-h-11 items-center justify-center gap-2 px-3 py-3 text-sm"
          >
            <ScanLine size={18} strokeWidth={1.8} aria-hidden />
            Scan a bottle
          </Link>
          <Link
            href="/search"
            className="btn-secondary flex min-h-11 items-center justify-center gap-2 px-3 py-3 text-sm"
          >
            <Search size={18} strokeWidth={1.8} aria-hidden />
            Search
          </Link>
        </div>
        <Link
          href="/welcome"
          className="mt-2 inline-flex min-h-11 items-center text-sm text-muted transition-colors hover:text-foreground"
        >
          Take the tour
        </Link>
      </section>
    );
  }

  const bottles = `${bottleCount} bottle${bottleCount === 1 ? "" : "s"} on your shelf`;
  const pours = `${pourCount} pour${pourCount === 1 ? "" : "s"} logged`;

  return (
    <section aria-label="Your next pour" className="card p-5">
      <h2 className="font-display text-xl font-semibold">Your next pour</h2>
      <p className="mt-1 text-sm text-muted">
        {bottles} · {pours}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link
          href="/pour"
          className="btn-primary flex min-h-11 items-center justify-center gap-2 px-3 py-3 text-sm"
        >
          <GlassWater size={18} strokeWidth={1.8} aria-hidden />
          Log a pour
        </Link>
        <Link
          href="/search"
          className="btn-secondary flex min-h-11 items-center justify-center gap-2 px-3 py-3 text-sm"
        >
          <Search size={18} strokeWidth={1.8} aria-hidden />
          Add a bottle
        </Link>
      </div>
    </section>
  );
}

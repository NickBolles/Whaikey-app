import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { FlavorWheelExplorer } from "@/components/flavor-wheel-explorer";

export const metadata: Metadata = {
  title: "Flavor wheel explorer",
  description: "Tour the eight flavor families of whiskey — where each comes from and how to spot it.",
};

export default function FlavorExplorerPage() {
  return (
    <div className="px-4 pt-5 flex flex-col gap-6">
      <header>
        <Link
          href="/learn"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground transition-colors -ml-1 py-2"
        >
          <ChevronLeft size={18} strokeWidth={1.8} aria-hidden /> Whiskey School
        </Link>
        <h1 className="font-display text-[1.7rem] leading-tight font-semibold mt-3">
          The flavor wheel
        </h1>
        <p className="text-muted mt-2 leading-relaxed">
          Eight families, ~55 flavors — the same wheel you use when logging a pour. Learn where each
          family comes from, then go find it in the glass.
        </p>
      </header>

      <FlavorWheelExplorer />

      <p className="text-xs text-muted/70 text-center pb-2">
        Palates differ — your green apple may be someone else&apos;s pear. Both are right.
      </p>
    </div>
  );
}

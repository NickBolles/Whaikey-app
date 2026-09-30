import type { Metadata } from "next";
import { FlavorWheelExplorer } from "@/components/flavor-wheel-explorer";

export const metadata: Metadata = {
  title: "Flavor wheel explorer",
  description: "Tour the eight flavor families of whiskey — where each comes from and how to spot it.",
};

export default function FlavorExplorerPage() {
  return (
    <div className="px-4 pt-5 flex flex-col gap-6">
      {/* Back to Whiskey School is the header's back slot (app-routes.ts). */}
      <header>
        <h1 className="font-display text-[1.7rem] leading-tight font-semibold">
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

import Link from "next/link";
import type { DB } from "@/db";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { FLAVOR_HEAT_SCOPES, getBarFlavorHeat, listUserBottles } from "@/lib/bar";
import { getUserPalate } from "@/lib/palate-store";
import { palateWheelHeat } from "@/lib/palate";
import { BarClient, type FlavorHeatMatrix } from "./bar-client";

export const dynamic = "force-dynamic";

/** Heat for every (source, scope) pair the Bar's two toggles can select. */
async function loadFlavorHeat(db: DB, userId: string): Promise<FlavorHeatMatrix> {
  const entries = await Promise.all(
    FLAVOR_HEAT_SCOPES.flatMap((scope) =>
      (["personal", "producer"] as const).map(async (source) => {
        const heat = await getBarFlavorHeat(db, userId, source, scope);
        return [`${source}:${scope}`, heat] as const;
      }),
    ),
  );
  return Object.fromEntries(entries) as FlavorHeatMatrix;
}

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

  const db = getDb();
  // Every (source, scope) pair up front: the wheel's two toggles then switch
  // instantly on the client instead of round-tripping for each combination.
  const [rows, flavorHeat, palate] = await Promise.all([
    listUserBottles(db, user.id),
    loadFlavorHeat(db, user.id),
    getUserPalate(db, user.id),
  ]);

  // The palate reaches the client already in wheel-heat form: it is one more
  // way to light the same wheel, not a second kind of chart.
  return (
    <BarClient
      initialRows={rows}
      flavorHeat={flavorHeat}
      palate={palateWheelHeat(palate)}
    />
  );
}

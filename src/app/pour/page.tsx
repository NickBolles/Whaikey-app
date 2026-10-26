import Link from "next/link";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { getBottleDetail } from "@/lib/search";
import { getPour } from "@/lib/pours";
import { PourFlow, type BottlePick, type EditEntry } from "./pour-flow";

export const dynamic = "force-dynamic";

export default async function PourPage({ searchParams }: { searchParams: Promise<{ bottleId?: string | string[]; edit?: string | string[] }> }) {
  const user = await getSessionUser();
  if (!user) return <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-5"><div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">🥃</div><div><h1 className="font-display text-2xl font-semibold">The bar is open</h1><p className="text-muted mt-2 max-w-sm">Sign in to log a pour and build your tasting journal.</p></div><Link href="/sign-in" className="btn-primary px-8 py-3">Sign in</Link></div>;

  const { bottleId: bottleIdParam, edit: editParam } = await searchParams;
  const editId = Array.isArray(editParam) ? editParam[0] : editParam;
  // Journal ⋯ → Edit (STORYBOARD §3.8): the same sheet, prefilled. Owner-scoped:
  // somebody else's id reads as no entry and the sheet opens blank.
  if (editId) {
    const found = await getPour(getDb(), user.id, editId);
    if (found) {
      const entry: EditEntry = {
        id: found.pour.id,
        bottle: { id: found.pour.bottleId, name: found.bottleName },
        rating: found.pour.rating,
        servingStyle: found.pour.servingStyle,
        amountMl: found.pour.amountMl,
        visibility: found.pour.visibility,
        note: {
          nose: found.note?.nose ?? null,
          palate: found.note?.palate ?? null,
          finish: found.note?.finish ?? null,
          freeform: found.note?.freeform ?? null,
          flavorTags: found.note?.flavorTags ?? null,
        },
      };
      return <PourFlow key={entry.id} userId={user.id} editEntry={entry} />;
    }
  }
  const bottleId = Array.isArray(bottleIdParam) ? bottleIdParam[0] : bottleIdParam;
  let initialBottle: BottlePick | null = null;
  if (bottleId) {
    const detail = await getBottleDetail(getDb(), bottleId, user.id);
    if (detail) initialBottle = { id: detail.bottle.id, name: detail.bottle.name, distillery: detail.distillery?.name, category: detail.bottle.category };
  }

  // A queued pour is stamped with its author so a flush after someone else
  // signs in on the same browser can't hand them this note.
  return <PourFlow userId={user.id} initialBottle={initialBottle} initialBottleMissing={Boolean(bottleId && !initialBottle)} />;
}

import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { listMyClubs } from "@/lib/clubs";
import { NewFlightForm } from "./new-flight-form";

export const dynamic = "force-dynamic";

export default async function NewFlightPage({ searchParams }: { searchParams: Promise<{ club?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in?next=/flights/new");
  const { club } = await searchParams;
  const clubs = await listMyClubs(getDb(), user.id);
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-3 pb-24 pt-5">
      <header>
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight">Host a tasting night</h1>
        <p className="mt-1 text-sm text-muted">
          Pick 3–6 bottles. Pour them into glasses A–F; everyone rates privately and you reveal together.
        </p>
      </header>
      <NewFlightForm clubs={clubs.map((c) => ({ id: c.id, name: c.name }))} defaultClubId={clubs.some((c) => c.id === club) ? club! : ""} />
    </div>
  );
}

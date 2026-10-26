import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { listMyClubs } from "@/lib/clubs";
import { appNow } from "@/lib/clock";
import { NewOutingForm } from "./new-outing-form";

export const dynamic = "force-dynamic";

/** Plan an outing — a group distillery visit (docs/SOCIAL.md §7.15, D22). */
export default async function NewOutingPage({ searchParams }: { searchParams: Promise<{ club?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in?next=/outings/new");
  const { club } = await searchParams;
  const clubs = await listMyClubs(getDb(), user.id);
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-3 pb-24 pt-5">
      <header>
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight">Plan an outing</h1>
        <p className="mt-1 text-sm text-muted">
          Heading to a distillery with friends? Everyone joins from a link or QR — no account needed for the day — logs
          what they taste, and you get a recap of the trip together.
        </p>
      </header>
      <NewOutingForm
        clubs={clubs.map((c) => ({ id: c.id, name: c.name }))}
        defaultClubId={clubs.some((c) => c.id === club) ? club! : ""}
        today={appNow().toISOString().slice(0, 10)}
      />
    </div>
  );
}

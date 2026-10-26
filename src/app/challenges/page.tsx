import { redirect } from "next/navigation";
import { TRAIL } from "@/lib/challenges/term";

/** Renamed to Trails (docs/SOCIAL.md D23); old links and notifications land on the new page. */
export default async function ChallengesRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (first != null) params.set(k, first);
  }
  const query = params.toString();
  redirect(`${TRAIL.path}${query ? `?${query}` : ""}`);
}

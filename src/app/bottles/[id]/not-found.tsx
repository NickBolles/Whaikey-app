import Link from "next/link";
import { StateScreen } from "@/components/state-screen";

/**
 * A bottle id that is not in the catalog — or a submitted bottle that is not
 * yours to see (`catalogVisibleTo`), which must read the same so the page
 * does not confirm it exists. The way out is the catalog itself.
 */
export default function BottleNotFound() {
  return (
    <StateScreen
      emoji="🔎"
      title="We can't find that bottle"
      action={
        <Link href="/search" className="btn-primary px-8 py-3">
          Search the catalog
        </Link>
      }
    >
      It isn&apos;t in the catalog, or the link is off by a letter.
    </StateScreen>
  );
}

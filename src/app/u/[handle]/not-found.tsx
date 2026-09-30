import Link from "next/link";
import { StateScreen } from "@/components/state-screen";

/**
 * No profile under that handle — or one this viewer may not see (a blocked
 * or suspended account), which reads identically on purpose: the page must
 * not tell anyone which of those it is.
 */
export default function ProfileNotFound() {
  return (
    <StateScreen
      emoji="👤"
      title="No one by that handle"
      action={
        <Link href="/friends" className="btn-primary px-8 py-3">
          Find friends
        </Link>
      }
    >
      Handles can change. If a friend sent this, ask them for their current link.
    </StateScreen>
  );
}

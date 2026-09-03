"use client";

import { useState } from "react";
import { signOut } from "@/lib/auth-client";

/**
 * The one account action reachable from the blocked gate, and it has to
 * actually work.
 *
 * A link to `/sign-in` does not end a session — it renders the sign-in page
 * while the blocked session is still live, so the layout bounces straight back
 * to the gate. Somebody who answered on the wrong account (or on a shared
 * device) would have no way out but clearing cookies.
 */
export function SignOutButton({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signOut().finally(() => {
          // A hard navigation rather than a router push: the session cookie is
          // gone, and every cached server render above this one was made for
          // the account that just left.
          window.location.href = "/sign-in";
        });
      }}
      className={className}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

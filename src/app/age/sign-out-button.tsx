"use client";

import { useState } from "react";
import { signOutCompletely } from "@/lib/sign-out";

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
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          void signOutCompletely()
            .then(({ pushReleased }) => {
              if (!pushReleased) {
                // Said out loud rather than silently accepted: notifications
                // for this account can keep arriving on this device until the
                // registration goes stale.
                console.warn("[push] signed out with this device still registered");
              }
              // A hard navigation rather than a router push: the session
              // cookie is gone, and every cached server render above this one
              // was made for the account that just left.
              window.location.href = "/sign-in";
            })
            .catch(() => {
              // Only on success. Landing on a signed-out-looking page with a
              // live session is the worst of both — on a shared device the
              // next person walks back into this account.
              setBusy(false);
              setFailed(true);
            });
        }}
        className={className}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {failed && (
        <p role="alert" className="text-xs text-danger">
          Couldn&apos;t sign out — you&apos;re still signed in. Check your connection and try
          again.
        </p>
      )}
    </div>
  );
}

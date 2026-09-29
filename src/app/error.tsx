"use client";

import Link from "next/link";
import { useEffect } from "react";
import { StateScreen } from "@/components/state-screen";

/**
 * The route-level error boundary for everything under the root layout
 * (review REL-6.2): a pooler blip or a failed query used to render Next's raw
 * error page. The header and nav are outside this boundary, so they stay up.
 *
 * "Try again" re-fetches and re-renders the segment (`unstable_retry`), which
 * is the right answer for the transient failures this mostly catches. The
 * server-side error is already reported where it was thrown (WP-19); what
 * reaches the client is a digest, never the message, so that is all this logs.
 */
export default function RouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[route error]", error.digest ?? error);
  }, [error]);

  return (
    <StateScreen
      emoji="🫗"
      title="Something spilled"
      action={
        <div className="flex flex-col items-center gap-3">
          <button type="button" onClick={() => unstable_retry()} className="btn-primary px-8 py-3">
            Try again
          </button>
          <Link href="/" className="tap-target text-sm text-muted transition-colors hover:text-foreground">
            Back to Home
          </Link>
        </div>
      }
    >
      This page didn&apos;t load. Nothing you&apos;ve logged is lost.
      {error.digest ? (
        <span className="mt-2 block font-mono text-xs text-muted/80">Ref {error.digest}</span>
      ) : null}
    </StateScreen>
  );
}

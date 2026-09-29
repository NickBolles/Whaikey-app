"use client";

import "./globals.css";

/**
 * The last-resort boundary, for a failure in the root layout itself — the
 * session lookup, the age-gate read, the profile query (review REL-6.2). It
 * replaces the whole document, so it carries its own <html> and <body> and
 * depends on nothing that could be what just broke: no shell, no data, no
 * fonts beyond the system stack.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <title>Something spilled · Whaikey</title>
        <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
          <div aria-hidden className="text-5xl">
            🫗
          </div>
          <div>
            <h1 className="text-2xl font-semibold">Something spilled</h1>
            <p className="mx-auto mt-2 max-w-sm leading-relaxed text-muted">
              Whaikey didn&apos;t load. Nothing you&apos;ve logged is lost.
            </p>
            {error.digest ? (
              <p className="mt-2 font-mono text-xs text-muted/80">Ref {error.digest}</p>
            ) : null}
          </div>
          <button type="button" onClick={() => unstable_retry()} className="btn-primary px-8 py-3">
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}

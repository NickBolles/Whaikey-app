import { reportInBackground } from "@/lib/observability/errors";

/**
 * Resolve to `fallback` if `work` rejects or has not settled within `ms`.
 *
 * For optional page widgets (Home's badge card, friends module, journal):
 * one slow or failing read must cost that widget, not the page. The losing
 * query keeps running; the DB watchdog (src/db/resilient-client.ts) is what
 * eventually cancels it. Failures are still reported, never swallowed.
 */
export function withFallback<T>(work: Promise<T> | PromiseLike<T>, fallback: T, label: string, ms = 6000): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.warn(`[settle] ${label} took longer than ${ms} ms; rendering without it`);
      resolve(fallback);
    }, ms);
    Promise.resolve(work).then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(fallback);
        }
        reportInBackground(error, { where: `settle:${label}` });
      },
    );
  });
}

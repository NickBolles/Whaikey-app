import { after } from "next/server";
import { reportInBackground } from "@/lib/observability/errors";

/**
 * Run enrichment work after the response is sent, inside the same invocation
 * (`after()` → the platform's `waitUntil`), so the user's request returns
 * immediately and the step still gets the function's full maxDuration.
 * Outside a request scope (tests, scripts) the work just runs unattended.
 */
const pending = new Set<Promise<unknown>>();

export function kick(work: () => Promise<unknown>): void {
  const p = work()
    .catch((err) => reportInBackground(err, { where: "enrich/kick" }))
    .finally(() => pending.delete(p));
  pending.add(p);
  try {
    after(p);
  } catch {
    void p;
  }
}

/** Test seam: wait for every kicked task to settle. */
export async function settleKicks(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

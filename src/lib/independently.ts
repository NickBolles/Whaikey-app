/**
 * Run independent steps independently.
 *
 * Written because the same defect has now been found at two levels of the same
 * call stack, one review round apart: a sequence of `await`s where nothing
 * downstream depends on anything upstream, so the FIRST failure silently
 * cancels every step after it. In the retention path that means which tables
 * stop being pruned is decided by their position in a list — `/api/cron/sweep`
 * had it across its seven tasks, and `sweepTelemetry` had it again across the
 * three deletes inside one of those tasks.
 *
 * The helper exists rather than a third hand-rolled loop because the rule is
 * the thing worth keeping, not the loop: **if nothing here depends on anything
 * else here, one broken step must not decide the fate of the others.**
 *
 * Sequential rather than `Promise.allSettled`: these touch different tables
 * through one connection pool, and a nightly job has no deadline worth a
 * thundering herd. The point is isolation, not concurrency.
 */
export interface StepOutcome<T> {
  name: string;
  value?: T;
  error?: unknown;
}

export async function runIndependently<T>(
  steps: Array<readonly [string, () => Promise<T>]>,
): Promise<{ outcomes: Array<StepOutcome<T>>; failed: string[] }> {
  const outcomes: Array<StepOutcome<T>> = [];
  const failed: string[] = [];
  for (const [name, run] of steps) {
    try {
      outcomes.push({ name, value: await run() });
    } catch (error) {
      outcomes.push({ name, error });
      failed.push(name);
    }
  }
  return { outcomes, failed };
}

/**
 * The error a caller throws when some steps failed and the rest were done.
 *
 * Names every failed step, so two different broken tables produce two
 * different messages and therefore two different Sentry issues rather than one
 * that hides the second behind the first. `cause` carries the first real error
 * so the stack is not lost.
 */
export function stepsFailed(label: string, failed: string[], outcomes: Array<StepOutcome<unknown>>): Error {
  const first = outcomes.find((o) => o.error !== undefined)?.error;
  return new Error(`${label}: ${failed.join(", ")} failed`, { cause: first });
}

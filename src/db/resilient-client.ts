import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A postgres-js client that cannot hang a serverless function forever.
 *
 * Production (2026-10-27) showed signed-in pages, `/api/auth/sign-in/social`
 * and the Google callback sitting for the full 300 s Vercel limit with no
 * error. The old client was `postgres(url, { max: 1 })`: one socket per
 * instance, shared by every concurrent request on a Fluid instance and by the
 * `after()` work (popularity tallies, enrichment steps). Two ways that wedges:
 *
 *   - a statement that runs long on the server (Supabase caps the `postgres`
 *     role at 2 min — the 00:40Z sign-in died on exactly that, 57014) holds
 *     the only connection, and everything queued behind it waits;
 *   - a socket that went dead while the instance was frozen between
 *     invocations never answers at all, so nothing ever rejects.
 *
 * Supavisor's transaction mode (port 6543) ignores session settings, so a
 * `statement_timeout` startup parameter is not a reliable fix there. Instead
 * this wrapper keeps a watchdog on every query from the outside:
 *
 *   1. after `queryTimeoutMs` it asks the server to cancel the statement
 *      (postgres-js `query.cancel()` → CancelRequest → 57014, which frees the
 *      connection and rejects that one query);
 *   2. if the query still has not settled `graceMs` later, the connection is
 *      presumed dead: the whole pool is swapped for a fresh one and the old one
 *      is ended with `timeout: 0`, which rejects everything stuck on it.
 *
 * The facade keeps the shape drizzle needs (`unsafe`, `begin`, `options`,
 * `end`) and stays a function (callers detect postgres-js by `typeof`), so a
 * reset is invisible to holders of the DB handle — Better Auth's adapter
 * captures it once at module load.
 */

/**
 * A wider watchdog for known-long work (the enrichment cron's catalog scans),
 * scoped with AsyncLocalStorage so it never leaks into a page render.
 */
const budget = new AsyncLocalStorage<number>();

export function withDbBudget<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  return budget.run(timeoutMs, fn);
}

export interface PgQueryLike extends PromiseLike<unknown> {
  cancel?: () => unknown;
  values?: () => PgQueryLike;
}

export interface PgClientLike {
  (...args: unknown[]): unknown;
  unsafe: (query: string, params?: unknown[], options?: unknown) => PgQueryLike;
  begin: (...args: unknown[]) => Promise<unknown>;
  end: (options?: { timeout?: number }) => Promise<unknown>;
  options: { parsers: Record<string, unknown>; serializers: Record<string, unknown> } & Record<string, unknown>;
}

export interface ResilientOptions {
  /** Ask the server to cancel a statement after this long. 0 disables the watchdog. */
  queryTimeoutMs: number;
  /** Then wait this much longer for the cancel to land before resetting the pool. */
  graceMs?: number;
  /** A whole transaction (drizzle `db.transaction`) may run this long. 0 disables. */
  transactionTimeoutMs?: number;
  /** Observability hook (never receives parameters or credentials). */
  onEvent?: (event: { kind: "cancel" | "reset"; query: string; elapsedMs: number }) => void;
}

/** First 120 chars of the SQL, whitespace collapsed — enough to name the query in a log line. */
export function describeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function createResilientClient(factory: () => PgClientLike, opts: ResilientOptions): PgClientLike & { resets: () => number } {
  let current = factory();
  let resets = 0;
  const grace = opts.graceMs ?? 5000;

  function reset(query: string, startedAt: number) {
    const old = current;
    const next = factory();
    // drizzle mutates `options.parsers/serializers` once, on the first client.
    Object.assign(next.options.parsers, old.options.parsers);
    Object.assign(next.options.serializers, old.options.serializers);
    current = next;
    resets += 1;
    opts.onEvent?.({ kind: "reset", query: describeQuery(query), elapsedMs: Date.now() - startedAt });
    // Rejects every query still waiting on the dead connection(s).
    void Promise.resolve()
      .then(() => old.end({ timeout: 0 }))
      .catch(() => {});
  }

  /**
   * Arm the watchdog when the query is actually sent. postgres-js queries are
   * lazy (they run on the first `then`), and drizzle calls `.values()` before
   * awaiting, so subscribing early would run the query in the wrong mode.
   */
  function watch(q: PgQueryLike, query: string): PgQueryLike {
    if (!opts.queryTimeoutMs || typeof q.then !== "function") return q;
    const base = opts.queryTimeoutMs;
    const originalThen = q.then.bind(q);
    let armed = false;
    let settled = false;
    let t1: ReturnType<typeof setTimeout> | undefined;
    let t2: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      settled = true;
      if (t1) clearTimeout(t1);
      if (t2) clearTimeout(t2);
    };
    (q as { then: PromiseLike<unknown>["then"] }).then = ((onFulfilled, onRejected) => {
      if (!armed) {
        armed = true;
        const startedAt = Date.now();
        const owner = current;
        const limit = Math.max(base, budget.getStore() ?? 0);
        t1 = setTimeout(() => {
          if (settled) return;
          opts.onEvent?.({ kind: "cancel", query: describeQuery(query), elapsedMs: Date.now() - startedAt });
          try {
            void Promise.resolve(q.cancel?.()).catch(() => {});
          } catch {
            /* cancel is best-effort */
          }
          t2 = setTimeout(() => {
            // Only reset the pool this query was sent on (another watchdog may have already).
            if (!settled && owner === current) reset(query, startedAt);
          }, grace);
          (t2 as { unref?: () => void }).unref?.();
        }, limit);
        (t1 as { unref?: () => void }).unref?.();
      }
      return originalThen(
        (value) => {
          done();
          return onFulfilled ? onFulfilled(value) : value;
        },
        (error) => {
          done();
          if (onRejected) return onRejected(error);
          throw error;
        },
      );
    }) as PromiseLike<unknown>["then"];
    // `.values()` returns the same query object in postgres-js; keep the
    // wrapped `then` on whatever it hands back.
    if (typeof q.values === "function") {
      const originalValues = q.values.bind(q);
      q.values = () => {
        const v = originalValues();
        return v === q ? q : watch(v, query);
      };
    }
    return q;
  }

  const facade = function (this: unknown, ...args: unknown[]) {
    return (current as (...a: unknown[]) => unknown).apply(this, args);
  } as unknown as PgClientLike & { resets: () => number };

  Object.defineProperty(facade, "options", { get: () => current.options, enumerable: true });
  facade.unsafe = (query, params, options) => watch(current.unsafe(query, params, options), query);
  facade.begin = (...args: unknown[]) => {
    const owner = current;
    const run = owner.begin(...args);
    const configured = opts.transactionTimeoutMs ?? 0;
    if (!configured) return run;
    const limit = Math.max(configured, budget.getStore() ?? 0);
    const startedAt = Date.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled && owner === current) reset("BEGIN … (transaction)", startedAt);
    }, limit + grace);
    (timer as { unref?: () => void }).unref?.();
    return run.finally(() => {
      settled = true;
      clearTimeout(timer);
    });
  };
  facade.end = (options) => current.end(options);
  facade.resets = () => resets;
  return facade;
}

/** Pooler mode from a connection string, without exposing any part of it. */
export function poolerMode(url: string): "transaction" | "session" | "direct" | "unknown" {
  try {
    const u = new URL(url);
    const pooler = /pooler\.supabase\.com$/i.test(u.hostname);
    const port = u.port || "5432";
    if (port === "6543") return "transaction";
    if (pooler) return "session";
    return "direct";
  } catch {
    return "unknown";
  }
}

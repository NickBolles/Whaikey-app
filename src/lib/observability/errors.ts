import { after } from "next/server";
import type { NodeClient } from "@sentry/node";

/**
 * The one place an unexpected error leaves this process for a third party.
 *
 * **Off unless the owner turns it on.** With `SENTRY_DSN` unset every entry
 * point here is a no-op — the same shape as `WHAIKEY_CSP_ENFORCE` and
 * `legalIdentity()`: the feature ships, the secret is the owner's, and nothing
 * invents one. That is also why the Privacy Policy's Sentry entry is rendered
 * conditionally on the DSN: naming a processor we do not use is the same class
 * of error as omitting one we do.
 *
 * **Server-only, deliberately.** `@sentry/node` rather than `@sentry/nextjs`,
 * because the seam this attaches to is `withErrorHandling` and the CSP
 * endpoint — both server. `@sentry/nextjs` would add build-time
 * instrumentation and ship its client bundle to every visitor whether or not a
 * DSN is set, which on an app the native shell loads over the network is real
 * bytes for a feature that is off. The cost of this choice is honest and worth
 * writing down: **no browser errors, no source-mapped stacks, no automatic
 * breadcrumbs.** If those are wanted, `@sentry/nextjs` is the upgrade and this
 * module is still the seam — `captureError` does not change.
 *
 * **What leaves this process is a decision, not a default.** Sentry's SDK is
 * built to collect; this codebase has three things that must never reach a
 * third party — a `/s/` share code (a bearer credential), the keyed phone
 * hash, and the user's email — so `beforeSend` strips them on the way out
 * rather than trusting each call site to have been careful. `sendDefaultPii`
 * stays false, which already withholds cookies, headers and IP.
 */

let client: NodeClient | null = null;
/** The in-flight or finished construction; see `getClient`. */
let clientPromise: Promise<NodeClient | null> | null = null;
let testHook: ((event: CapturedEvent) => void) | null = null;

/** What a test observes: the payload, after redaction, that would be sent. */
export interface CapturedEvent {
  kind: "error" | "message";
  message: string;
  /**
   * What would actually be transmitted alongside the message.
   *
   * Added because its absence hid a leak: a redaction test asserted that no
   * fragment of a tasting note appeared in this object, and passed, while the
   * note sat in the stack's first line — a surface the object did not have.
   * An assertion is only as good as the thing it can see.
   */
  stack?: string;
  level: "error" | "warning";
  context: ErrorContext;
}

export interface ErrorContext {
  /** Which surface this came from: an API route path, a job name. */
  where?: string;
  /**
   * The account, by id only.
   *
   * An id is what every table keys on and means nothing outside this database;
   * an email is a claim about a person and is readable by anyone who reaches
   * the issue. Same rule `operator.ts` applies to who may work the queue.
   */
  userId?: string;
  /** Small, non-identifying labels — a route, a feature, a directive. */
  tags?: Record<string, string>;
}

/** Configured only when the owner has supplied a DSN. */
export function isErrorMonitoringConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

/**
 * Redaction applied to every string that leaves, whatever produced it.
 *
 * Written against the *output* rather than the input because the SDK collects
 * from places no call site controls — a stack frame's source line, an error
 * message that interpolated a URL, a breadcrumb. A guard that each caller has
 * to remember is the kind that gets forgotten once and then leaks forever.
 */
export function redactSensitive(text: string): string {
  return (
    text
      // A share code is a bearer credential: holding it reads the note.
      .replace(/\/(s|add)\/[A-Za-z0-9_-]+/g, "/$1/[redacted]")
      /**
       * Email addresses, wherever they were interpolated from.
       *
       * The local-part class is deliberately wide. `[\w.+-]+` missed every
       * character RFC 5322 allows and people actually use — an apostrophe
       * above all — so `sam.o'x+tag@example.co.uk` matched only from the `x`
       * and left `sam.o'` in the payload: the identifying half of the address
       * surviving a guarantee that it would not. A redaction that removes the
       * common case and leaks the unusual one is worse than none, because it
       * is trusted.
       */
      .replace(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
      // The keyed phone hash is a stable identifier for a real phone number.
      .replace(/\b[a-f0-9]{64}\b/gi, "[hash]")
  );
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === "string") return redactSensitive(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * One initialisation, shared by everyone who asks for it.
 *
 * The flag version set `initialised = true` and then `await`ed the dynamic
 * import, so a second report arriving during a cold start saw "initialised"
 * and read a `client` that was still null — and dropped its event. Two
 * failures at once is not an exotic case; it is what a cold start under load
 * looks like, and the second one is often the more interesting.
 *
 * Caching the promise instead makes every concurrent caller await the same
 * construction. `isErrorMonitoringConfigured()` stays outside the cache so
 * turning the DSN on or off is still read fresh.
 */
async function getClient(): Promise<NodeClient | null> {
  if (!isErrorMonitoringConfigured()) return null;
  clientPromise ??= buildClient();
  return clientPromise;
}

async function buildClient(): Promise<NodeClient | null> {
  try {
    const Sentry = await import("@sentry/node");
    client = new Sentry.NodeClient({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? "development",
      release: process.env.VERCEL_GIT_COMMIT_SHA,
      // Cookies, headers and the client IP stay here. Nothing in this app needs
      // them to diagnose a 500, and every one of them is about a person.
      sendDefaultPii: false,
      // Errors only. Tracing would sample ordinary requests — a much larger
      // surface for the redaction above to be wrong about, bought for
      // performance data PLAN-A9 does not ask a third party for.
      tracesSampleRate: 0,
      integrations: [],
      transport: Sentry.makeNodeTransport,
      stackParser: Sentry.defaultStackParser,
      beforeSend: (event) => redactDeep(event) as typeof event,
      beforeBreadcrumb: (crumb) => redactDeep(crumb) as typeof crumb,
    });
    client.init();
    return client;
  } catch (err) {
    // Monitoring must never be the reason a request fails. If the SDK cannot
    // start, say so once and carry on unmonitored.
    console.error("[observability] Sentry failed to initialise", err);
    client = null;
    return null;
  }
}

function applyScope(
  scope: import("@sentry/node").Scope,
  context: ErrorContext,
): void {
  if (context.userId) scope.setUser({ id: context.userId });
  if (context.where) scope.setTag("where", context.where);
  for (const [k, v] of Object.entries(context.tags ?? {})) scope.setTag(k, redactSensitive(v));
}

/**
 * Report an unexpected error. Never throws and never rejects: a failure to
 * report is not a reason to fail the thing that was being reported about.
 */
/**
 * What a `DrizzleQueryError` carries, and why it must never be reported as-is.
 *
 * Drizzle builds its message as `Failed query: <sql>\nparams: <values>` — the
 * **bound parameters**, which on this app's write paths are a tasting note, a
 * comment body, a feedback message, a handle. A failed insert would therefore
 * have sent the user's own words to a third party, which is the one thing
 * `/privacy` promises error reports do not contain. `redactSensitive` could
 * not catch it: it recognises share codes, emails and phone hashes, and a
 * tasting note looks like none of those. Redaction by pattern only ever
 * removes what somebody thought of in advance, so this removes the values by
 * **construction** instead of by recognition.
 *
 * The SQL itself stays — it is the schema, not the data, and it is most of the
 * diagnostic value. `cause` is deliberately dropped rather than chained: a
 * Postgres error embeds offending values in its own message ("Key (email)=(…)
 * already exists"), so keeping it would reintroduce the leak one level down.
 * The parts of it that are schema rather than data — the SQLSTATE code, the
 * constraint, the table and column — come through as tags, which is enough to
 * identify what broke.
 */
interface DrizzleQueryShape {
  query: string;
  params: unknown[];
}

function isDrizzleQueryError(err: unknown): err is Error & DrizzleQueryShape {
  const candidate = err as Partial<DrizzleQueryShape> | null;
  return (
    err instanceof Error &&
    typeof candidate?.query === "string" &&
    Array.isArray(candidate?.params)
  );
}

/** Schema-shaped fields only. Never `detail`, which quotes the values. */
const SAFE_DB_FIELDS = ["code", "constraint", "table", "column", "schema"] as const;

/**
 * A stack whose header is the SANITISED message.
 *
 * `err.stack` in Node is `"<Name>: <message>\n    at …"` — the message is the
 * first line of it. So copying the original stack onto the sanitised error put
 * the parameters straight back into the payload, one field over from where
 * they had just been removed. The redaction was real and the leak was total:
 * Sentry sends the stack.
 *
 * Two things made it survive review. The comment on the copied line said
 * "frames only; no data rides on a stack", which was simply wrong and said
 * confidently. And the tests asserted the absence of every fragment over
 * `CapturedEvent`, which had no `stack` field — so the assertion was correct
 * and inspected a surface the secret was never on. `CapturedEvent` carries the
 * stack now, so that class of test covers what is actually transmitted.
 *
 * Frames are kept because they are the diagnostic value and carry no data: a
 * frame is a file, a function and a position. Anything before the first frame
 * is discarded rather than parsed, since it is the message by construction.
 */
function rebuildStack(err: Error, header: string): string {
  const frames = (err.stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at\s/.test(line));
  return frames.length > 0 ? `${header}\n${frames.join("\n")}` : header;
}

function sanitizeForReport(err: unknown): { error: unknown; tags: Record<string, string> } {
  if (!isDrizzleQueryError(err)) return { error: err, tags: {} };

  const message = `Failed query: ${err.query} — params: [${err.params.length} value(s) withheld]`;
  const safe = new Error(message);
  safe.name = err.name;
  safe.stack = rebuildStack(err, `${err.name}: ${message}`);

  const tags: Record<string, string> = { db_error: "true" };
  const cause = err.cause;
  if (cause && typeof cause === "object") {
    for (const field of SAFE_DB_FIELDS) {
      const value = (cause as Record<string, unknown>)[field];
      if (typeof value === "string" && value) tags[`db_${field}`] = value;
    }
  }
  return { error: safe, tags };
}

/**
 * Errors this module has already filed.
 *
 * `onRequestError` receives Route Handler failures as well as Server Component
 * ones, and `reportingErrors` reports and then RETHROWS — so an error escaping
 * the cron sweep or a native-auth handler was captured by the wrapper, escaped
 * to Next, and captured again by the hook: two Sentry events and two pages for
 * one failure. Filtering by `routeType` instead would have been wrong in the
 * other direction, because it would drop any route handler that uses neither
 * wrapper.
 *
 * A `WeakSet` because it must not keep errors alive; marking is synchronous,
 * before the first `await` in `captureError`, so the mark is always in place
 * by the time a rethrow reaches Next.
 */
const alreadyReported = new WeakSet<object>();

/** Has this exact error object already been filed by this module? */
export function wasAlreadyReported(err: unknown): boolean {
  return typeof err === "object" && err !== null && alreadyReported.has(err);
}

export async function captureError(err: unknown, context: ErrorContext = {}): Promise<void> {
  // Marked synchronously, before any await, so a rethrow cannot outrun it.
  if (typeof err === "object" && err !== null) alreadyReported.add(err);
  try {
    // Inside the try, deliberately. `String(err)` runs arbitrary user code —
    // `toString` on whatever was thrown — and an earlier version computed it
    // above the try, where a throwing `toString` would have escaped and turned
    // reporting an error into a second, worse one. Writing the test for
    // "never throws" is what surfaced it: with no hook set, optional-call
    // short-circuiting meant the argument was never evaluated and the test
    // passed without exercising anything.
    // Stripped BEFORE anything reads the message — including the test hook,
    // so a test can assert the user's words are gone rather than assert that
    // a redactor was called.
    const { error: reportable, tags: dbTags } = sanitizeForReport(err);
    const reported: ErrorContext =
      Object.keys(dbTags).length > 0
        ? { ...context, tags: { ...(context.tags ?? {}), ...dbTags } }
        : context;
    testHook?.({
      kind: "error",
      message: redactSensitive(
        reportable instanceof Error ? reportable.message : String(reportable),
      ),
      stack: reportable instanceof Error ? redactSensitive(reportable.stack ?? "") : undefined,
      level: "error",
      context: reported,
    });
    const sentry = await getClient();
    if (!sentry) return;
    const { Scope } = await import("@sentry/node");
    const scope = new Scope();
    applyScope(scope, reported);
    sentry.captureException(reportable, undefined, scope);
    await flushQuietly(sentry);
  } catch (reportingError) {
    console.error("[observability] failed to report an error", reportingError);
  }
}

/**
 * Wait for the transport, not just for the queue.
 *
 * `captureException` and `captureMessage` **enqueue**; they return before the
 * event is on the wire. So the `after()` fix one function down was only ever
 * half of it — the platform kept the invocation alive until a promise that
 * resolved the moment the event entered Sentry's buffer, and then froze it
 * with the HTTP request still in flight. Exactly the bug `after()` was added
 * to fix, moved one layer in.
 *
 * Bounded, and deliberately short. `flush` extends a serverless invocation the
 * caller is paying for, and this is best-effort telemetry attached to a
 * request that has already failed: two seconds is enough for a healthy
 * transport and short enough that a sick one cannot hold the function open.
 * A `false` return means the queue did not drain in time — worth a line in the
 * log, never worth throwing, since the whole module's contract is that
 * reporting an error never becomes a second one.
 */
const FLUSH_TIMEOUT_MS = 2_000;

async function flushQuietly(sentry: NodeClient): Promise<void> {
  try {
    const drained = await sentry.flush(FLUSH_TIMEOUT_MS);
    if (!drained) {
      console.error("[observability] report queue did not drain before the timeout");
    }
  } catch (flushError) {
    console.error("[observability] failed to flush the report queue", flushError);
  }
}

/** Report something noteworthy that is not an exception — a CSP violation. */
export async function captureMessage(
  message: string,
  context: ErrorContext = {},
  level: "error" | "warning" = "warning",
): Promise<void> {
  const redacted = redactSensitive(message);
  testHook?.({ kind: "message", message: redacted, level, context });
  try {
    const sentry = await getClient();
    if (!sentry) return;
    const { Scope } = await import("@sentry/node");
    const scope = new Scope();
    applyScope(scope, context);
    sentry.captureMessage(redacted, level, undefined, scope);
    await flushQuietly(sentry);
  } catch (reportingError) {
    console.error("[observability] failed to report a message", reportingError);
  }
}

/**
 * Report an error without making the caller wait for it.
 *
 * `void captureError(...)` is not enough on a serverless platform. The
 * invocation is frozen the moment the response resolves, and a promise nobody
 * is holding is exactly what gets frozen mid-flight — so the reports most
 * worth having, the ones from a 500 that fired once at 3am, were the ones
 * least likely to arrive. `after()` hands the promise to the platform's
 * `waitUntil`, which keeps the invocation alive until it settles
 * (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`,
 * "supporting `after` for serverless platforms"), while still returning the
 * response immediately.
 *
 * `after()` throws when there is no request scope — a unit test calling
 * `withErrorHandling` directly, a script, a background job — and reporting an
 * error must never become a second error. Outside a request we fall back to
 * the fire-and-forget call, which is what those callers had anyway and is
 * safe there because nothing is about to freeze.
 */
export function reportInBackground(err: unknown, context: ErrorContext = {}): void {
  deferReport(() => captureError(err, context));
}

/**
 * `captureMessage`'s half of the same rule.
 *
 * Not an afterthought: `/api/csp-report` answers 204 and returns, and it is
 * unauthenticated, so it is the endpoint most likely to be serving a burst
 * from a real browser when the invocation is frozen. Splitting the fix across
 * two functions is how the `void` version of it survived its own review — the
 * error path got the attention and the message path on the next file over did
 * not.
 */
export function reportMessageInBackground(
  message: string,
  context: ErrorContext = {},
  level: "error" | "warning" = "warning",
): void {
  deferReport(() => captureMessage(message, context, level));
}

/**
 * Started once, then handed over — not started inside the `try`.
 *
 * The obvious spelling, `try { after(start()) } catch { void start() }`, calls
 * `start()` before `after` can throw and then calls it AGAIN in the catch, so
 * every report outside a request scope is filed twice. Capturing the promise
 * first makes the fallback a no-op that simply leaves it running, which is
 * what a caller with nothing about to freeze wants anyway.
 */
function deferReport(start: () => Promise<void>): void {
  const pending = start();
  try {
    after(pending);
  } catch {
    // No request scope: a unit test, a script, a job. Nothing will freeze the
    // process out from under it, so letting it settle unattended is safe —
    // and both capture functions swallow their own failures, so an unhandled
    // rejection is not on the table either.
    void pending;
  }
}

/**
 * Report anything this function throws, then rethrow it unchanged.
 *
 * `withErrorHandling` is the funnel for routes that want its 401/403/413/500
 * behaviour, and seven do not: the Better Auth catch-all, the three native
 * sign-in handlers, `/api/native/manifest` (which must fail OPEN — a version
 * check that locks people out on a hiccup is a worse outage than the one it
 * prevents), `/api/csp-report` (which reports directly), and `/api/cron/sweep`.
 * They own their own responses for good reasons, and routing them through a
 * wrapper that turns every failure into a 500 would break those reasons.
 *
 * What they were missing is only the *reporting*. This adds that and nothing
 * else: same error, same response, same status. The cron sweep is the one that
 * mattered most — it is unattended, so a failure there is invisible by
 * definition, and it is where the telemetry retention runs.
 */
export async function reportingErrors<T>(where: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    /**
     * Handed to `after()` rather than awaited.
     *
     * It used to `await captureError(...)` before rethrowing, which was
     * harmless while capture merely enqueued. Now that it also flushes the
     * transport, awaiting would add up to `FLUSH_TIMEOUT_MS` to every failing
     * request on all seven of these routes — including `/api/native/manifest`,
     * whose entire design is to fail fast and open. `reportInBackground` gives
     * the same delivery guarantee through `waitUntil` and costs the response
     * nothing, and `after` runs even when the request ends by throwing.
     */
    reportInBackground(err, { where });
    throw err;
  }
}

/**
 * Observe what would be sent, without a DSN and without network.
 *
 * The interesting assertions are about redaction, and those are exactly the
 * ones a mock of the SDK would not make — it would assert we called a
 * function, not that a share code was gone from what we passed it.
 */
export function setErrorReporterForTests(hook: ((event: CapturedEvent) => void) | null): void {
  testHook = hook;
  client = null;
  clientPromise = null;
}

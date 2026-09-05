import { NextResponse } from "next/server";
import { BodyTooLargeError, readTextWithinLimit } from "@/lib/body-limit";
import { reportMessageInBackground } from "@/lib/observability/errors";

/**
 * Where the Content-Security-Policy sends its violations (review SEC-H3).
 *
 * The policy ships report-only, and report-only is only worth anything if
 * somebody is reading the reports — otherwise it is an expensive way to write
 * a header. Violations go to error monitoring when a DSN is configured
 * (WP-19), and to the log either way: the log is what there is on a
 * deployment that has not turned Sentry on, and losing the reports on that
 * deployment would be the same "nobody is reading them" failure one level
 * down.
 *
 * Unauthenticated by necessity — browsers post these with no credentials — so
 * it is treated as hostile input: nothing is stored, the body is capped *as it
 * is read*, it is never parsed beyond the handful of fields worth logging, and
 * the answer is always 204 (or 413) so it can't be used to probe anything.
 */
export const dynamic = "force-dynamic";

/** Reports are a few hundred bytes; anything larger is not a report. */
const MAX_BODY_BYTES = 8_192;

/**
 * A ceiling on how much log a flood of reports can produce.
 *
 * The body guard bounds each request; nothing bounded how many, and this
 * endpoint takes no credentials — anything can POST `{}` forever and turn log
 * retention into someone else's bill. Real violations arrive in bursts of a
 * handful per page load, so a small allowance loses nothing worth reading, and
 * the suppressed count is reported once per window rather than dropped
 * silently.
 *
 * Per instance, not global: serverless spreads this across however many are
 * warm. That is a much weaker bound than a shared counter would be, and still
 * the difference between bounded and unbounded — a shared one needs a store,
 * which is the same gap as SEC-M3's unauthenticated throttling (WP-25).
 */
const LOG_WINDOW_MS = 60_000;
const MAX_LOGS_PER_WINDOW = 20;

let windowOpenedAt = 0;
let loggedInWindow = 0;
let suppressedInWindow = 0;

/** False when this report should be counted but not written. */
function admitToLog(now: number): boolean {
  if (now - windowOpenedAt >= LOG_WINDOW_MS) {
    if (suppressedInWindow > 0) {
      console.warn(`[csp] ${suppressedInWindow} further violation(s) not logged (rate limit)`);
    }
    windowOpenedAt = now;
    loggedInWindow = 0;
    suppressedInWindow = 0;
  }
  if (loggedInWindow >= MAX_LOGS_PER_WINDOW) {
    suppressedInWindow++;
    return false;
  }
  loggedInWindow++;
  return true;
}

interface CspReportBody {
  "csp-report"?: Record<string, unknown>;
}

function field(report: Record<string, unknown>, key: string): string {
  const value = report[key];
  // Truncated because every one of these is attacker-controlled text landing
  // in a log line.
  return typeof value === "string" ? value.slice(0, 300) : "";
}

/**
 * Path prefixes whose next segment is a bearer credential.
 *
 * `/s/<code>` is a share link: anyone holding it can read the note until it is
 * revoked. Logging a violation's `document-uri` verbatim would put those codes
 * in retained deployment logs — which is the same leak the `Referrer-Policy`
 * added alongside this endpoint exists to prevent, arriving by another door.
 */
const CREDENTIAL_PATH_PREFIXES = new Set(["s", "add"]);

/**
 * Keep enough of a URL to tell which page fired, and none of the secret.
 *
 * Query and fragment go unconditionally: nothing in them is needed to identify
 * a violated directive, and they are a standing invitation for a token.
 * Anything that isn't a URL (`eval`, `inline`) passes through untouched.
 */
function redactUri(raw: string): string {
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const [first] = url.pathname.split("/").filter(Boolean);
  const path = first && CREDENTIAL_PATH_PREFIXES.has(first) ? `/${first}/[redacted]` : url.pathname;
  return `${url.origin}${path}`;
}

export async function POST(req: Request) {
  let raw: string;
  try {
    // Metered while reading, not after: this endpoint takes no credentials, so
    // a chunked body or a lying Content-Length would otherwise buffer whatever
    // an attacker sends before the cap was ever consulted.
    raw = await readTextWithinLimit(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return new NextResponse(null, { status: 413 });
    return new NextResponse(null, { status: 204 });
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const report =
      typeof parsed === "object" && parsed !== null
        ? ((parsed as CspReportBody)["csp-report"] ?? (parsed as Record<string, unknown>))
        : {};

    if (!admitToLog(Date.now())) return new NextResponse(null, { status: 204 });

    const violation = {
      directive: field(report, "violated-directive") || field(report, "effective-directive"),
      blocked: redactUri(field(report, "blocked-uri")),
      document: redactUri(field(report, "document-uri")),
    };
    console.warn("[csp] violation", violation);
    // Redacted BEFORE it leaves, by `redactUri` above — the same values the
    // log gets. `captureMessage` redacts again on the way out, which is
    // belt-and-braces rather than duplication: this endpoint is
    // unauthenticated, so its input is hostile by definition and a single
    // guard on a path like that is one refactor away from being none.
    reportMessageInBackground(`CSP violation: ${violation.directive || "unknown directive"}`, {
      where: "csp-report",
      tags: {
        directive: violation.directive || "unknown",
        blocked: violation.blocked || "unknown",
        document: violation.document || "unknown",
      },
    });
  } catch {
    // A malformed report is not worth an error path; the browser sent it and
    // will not read the answer.
  }

  return new NextResponse(null, { status: 204 });
}

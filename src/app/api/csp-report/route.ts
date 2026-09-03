import { NextResponse } from "next/server";
import { BodyTooLargeError, readTextWithinLimit } from "@/lib/body-limit";

/**
 * Where the Content-Security-Policy sends its violations (review SEC-H3).
 *
 * The policy ships report-only, and report-only is only worth anything if
 * somebody is reading the reports — otherwise it is an expensive way to write
 * a header. This logs them, which is what there is until error monitoring
 * lands (WP-19); at that point this becomes a Sentry breadcrumb instead.
 *
 * Unauthenticated by necessity — browsers post these with no credentials — so
 * it is treated as hostile input: nothing is stored, the body is capped *as it
 * is read*, it is never parsed beyond the handful of fields worth logging, and
 * the answer is always 204 (or 413) so it can't be used to probe anything.
 */
export const dynamic = "force-dynamic";

/** Reports are a few hundred bytes; anything larger is not a report. */
const MAX_BODY_BYTES = 8_192;

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

    console.warn("[csp] violation", {
      directive: field(report, "violated-directive") || field(report, "effective-directive"),
      blocked: redactUri(field(report, "blocked-uri")),
      document: redactUri(field(report, "document-uri")),
    });
  } catch {
    // A malformed report is not worth an error path; the browser sent it and
    // will not read the answer.
  }

  return new NextResponse(null, { status: 204 });
}

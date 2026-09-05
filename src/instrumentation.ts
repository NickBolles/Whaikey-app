import type { Instrumentation } from "next";

/**
 * The other half of error monitoring: everything that is not an API route.
 *
 * `withErrorHandling` is the funnel for API handlers and `reportingErrors`
 * covers the seven that own their own responses — and between them they cover
 * no page at all. A Server Component that throws while rendering never touches
 * either seam, so a broken query on any of the app's page routes was invisible
 * to monitoring while the docstrings talked confidently about coverage. This
 * is Next's own hook for exactly that
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`).
 *
 * `register` is deliberately absent: there is nothing to start at boot, since
 * the Sentry client is built lazily on first report and stays off entirely
 * without a DSN.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { captureError, redactSensitive, wasAlreadyReported } = await import(
    "@/lib/observability/errors"
  );

  /**
   * This hook gets Route Handler failures too, not only rendering ones — and
   * `reportingErrors` reports and then rethrows, so an error escaping the cron
   * sweep or a native-auth handler would arrive here already filed. Two events
   * and two pages for one failure is how an alert gets muted.
   *
   * Filtered by identity rather than by `context.routeType`, because skipping
   * every `"route"` would silently drop any handler that uses neither wrapper
   * — trading a duplicate for a hole, which is the worse trade for monitoring.
   */
  if (wasAlreadyReported(err)) return;

  /**
   * The path is redacted before it becomes a tag. `beforeSend` would catch it
   * too, but a `/s/<code>` share link is a bearer credential and this is the
   * one place a URL is deliberately copied into the payload — a guard that
   * only exists downstream is one refactor away from not existing.
   */
  const path = typeof request.path === "string" ? redactSensitive(request.path) : "unknown";

  /**
   * React may replace the thrown error during a Server Component render, in
   * which case `digest` is the only handle on which error it actually was
   * (the file-convention doc says so). Carried as a tag so a report can be
   * matched to the digest the user's browser was shown.
   */
  const digest =
    typeof err === "object" && err !== null && "digest" in err
      ? String((err as { digest: unknown }).digest)
      : undefined;

  // Awaited, per the doc: this hook fires outside any request scope we
  // control, so nothing else is keeping the report alive.
  await captureError(err, {
    where: `render:${context.routerKind}`,
    tags: {
      path,
      router: context.routerKind,
      routeType: context.routeType,
      ...(digest ? { digest } : {}),
    },
  });
};

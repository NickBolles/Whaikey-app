import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth";
import { auth } from "./auth";
import { setErrorReporterForTests, type CapturedEvent } from "@/lib/observability/errors";

/**
 * Better Auth catches everything its handlers throw and answers with its own
 * response, so nothing escapes to a wrapper around `/api/auth/[...all]` or to
 * Next's `onRequestError`. `onAPIError.onError` is the only place a sign-in
 * outage is observable, which makes it worth a test of its own: a comment
 * saying the route is covered is what stopped this being noticed the first
 * time.
 */
const onError = (auth.options as { onAPIError?: { onError?: (e: unknown, c?: unknown) => void } })
  .onAPIError?.onError;

describe("sign-in failures reach monitoring", () => {
  let captured: CapturedEvent[];
  beforeEach(() => {
    captured = [];
    setErrorReporterForTests((e) => captured.push(e));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    setErrorReporterForTests(null);
    vi.restoreAllMocks();
  });

  it("is wired to Better Auth's own error boundary", () => {
    // Without this hook the catch-all reports nothing at all: the route
    // exports toNextJsHandler(auth) and Better Auth never rethrows.
    expect(typeof onError).toBe("function");
  });

  it("reports an unexpected exception", async () => {
    onError?.(new Error("adapter lost the database"), {});
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0].context.where).toBe("api/auth/[...all]");
    expect(captured[0].message).toContain("adapter lost the database");
  });

  it("reports a 5xx from Better Auth itself", async () => {
    onError?.(new APIError("INTERNAL_SERVER_ERROR", { message: "session write failed" }), {});
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0].context.where).toBe("api/auth/[...all]");
  });

  it("stays quiet for a refused request", async () => {
    // A stale state parameter, an unknown provider, a rate limit: the system
    // working. One report per failed attempt is how a signal becomes noise
    // and then becomes ignored -- the same mistake as filing a closed chat tab.
    onError?.(new APIError("UNAUTHORIZED", { message: "nope" }), {});
    onError?.(new APIError("BAD_REQUEST", { message: "bad state" }), {});
    await new Promise((r) => setTimeout(r, 20));
    expect(captured).toHaveLength(0);
  });
});

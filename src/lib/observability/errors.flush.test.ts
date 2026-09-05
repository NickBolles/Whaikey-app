import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The transport half of the serverless-freeze fix, which needs a real client
 * and therefore its own file: `getClient()` caches in module state, so a test
 * that constructs one would poison the redaction tests next door. Vitest
 * isolates modules per file, so this is the cheap way to get a clean seam.
 */

const captureException = vi.fn();
const captureMessage = vi.fn();
const flush = vi.fn(async () => true);
/** Call order across the two, which is the whole assertion. */
const calls: string[] = [];

vi.mock("@sentry/node", () => {
  class NodeClient {
    init() {}
    captureException(...args: unknown[]) {
      calls.push("capture");
      captureException(...args);
    }
    captureMessage(...args: unknown[]) {
      calls.push("capture");
      captureMessage(...args);
    }
    async flush(timeout?: number) {
      calls.push(`flush:${timeout}`);
      return flush();
    }
  }
  class Scope {
    setTag() {}
    setUser() {}
    setContext() {}
    setExtra() {}
  }
  return { NodeClient, Scope, makeNodeTransport: () => ({}), defaultStackParser: () => [] };
});

afterEach(() => {
  delete process.env.SENTRY_DSN;
  calls.length = 0;
  vi.clearAllMocks();
});

describe("waiting for the transport, not just the queue", () => {
  it("flushes after capturing an error, with a bounded timeout", async () => {
    process.env.SENTRY_DSN = "https://key@example.ingest.sentry.io/1";
    const { captureError } = await import("./errors");

    await captureError(new Error("boom"), { where: "api" });

    // `captureException` only enqueues. Without the flush, the promise
    // `after()` is holding resolves while the HTTP request is still in
    // flight — the exact freeze `after()` was added to prevent, one layer in.
    expect(calls).toEqual(["capture", "flush:2000"]);
    // Bounded on purpose: a flush extends a serverless invocation somebody is
    // paying for, and this is best-effort telemetry on an already-failed
    // request. A sick transport must not hold the function open.
    expect(calls[1]).toBe("flush:2000");
  });

  it("flushes after a message too", async () => {
    process.env.SENTRY_DSN = "https://key@example.ingest.sentry.io/1";
    const { captureMessage: report } = await import("./errors");

    await report("CSP violation", { where: "csp-report" });

    expect(calls).toEqual(["capture", "flush:2000"]);
  });

  it("does not throw when the queue fails to drain", async () => {
    process.env.SENTRY_DSN = "https://key@example.ingest.sentry.io/1";
    flush.mockResolvedValueOnce(false);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureError } = await import("./errors");

    // A timed-out flush is worth a log line and nothing more: this module's
    // whole contract is that reporting an error never becomes a second one.
    await expect(captureError(new Error("boom"))).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalled();
  });
});

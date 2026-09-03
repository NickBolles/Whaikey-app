import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

/**
 * The CSP's report sink. Browsers post here with no credentials, so it takes
 * hostile input by design: nothing is stored, and the body is capped as it is
 * read rather than after (review SEC-M1's failure mode, in an endpoint that
 * needs no session to reach).
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report", ...headers },
    body,
  });
}

/** Chunked: no Content-Length at all, which is the case the header can't catch. */
function chunked(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("http://localhost:3000/api/csp-report", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("POST /api/csp-report", () => {
  it("logs a violation and answers 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(
      post(
        JSON.stringify({
          "csp-report": {
            "violated-directive": "script-src",
            "blocked-uri": "https://evil.example/x.js",
            "document-uri": "https://app.whaikey.com/bar",
          },
        }),
      ),
    );

    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(
      "[csp] violation",
      expect.objectContaining({ directive: "script-src", blocked: "https://evil.example/x.js" }),
    );
  });

  it("refuses an oversized report", async () => {
    const res = await POST(post(JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(9_000) } })));
    expect(res.status).toBe(413);
  });

  it("refuses an oversized chunked report, which no header would have caught", async () => {
    const res = await POST(chunked(["x".repeat(5_000), "x".repeat(5_000)]));
    expect(res.status).toBe(413);
  });

  /**
   * `/s/<code>` is a bearer share link. Logging `document-uri` verbatim would
   * put those codes in retained deployment logs — the same leak the
   * Referrer-Policy shipped alongside this endpoint exists to prevent, coming
   * in through the back.
   */
  it("keeps share codes out of the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await POST(
      post(
        JSON.stringify({
          "csp-report": {
            "violated-directive": "img-src",
            "document-uri": "https://app.whaikey.com/s/9f3a1c7b2d?utm=x",
          },
        }),
      ),
    );

    const logged = warn.mock.calls[0][1] as { document: string };
    expect(logged.document).not.toContain("9f3a1c7b2d");
    expect(logged.document).toBe("https://app.whaikey.com/s/[redacted]");
  });

  it("keeps the ordinary page path, which is what makes a report useful", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await POST(
      post(
        JSON.stringify({
          "csp-report": {
            "document-uri": "https://app.whaikey.com/bottles/lagavulin-16?q=1#x",
            "blocked-uri": "eval",
          },
        }),
      ),
    );

    const logged = warn.mock.calls[0][1] as { document: string; blocked: string };
    expect(logged.document).toBe("https://app.whaikey.com/bottles/lagavulin-16");
    // Query and fragment always go — they are a standing invitation for a token.
    expect(logged.document).not.toContain("q=1");
    // And a non-URL blocked value survives intact, since that is the useful bit.
    expect(logged.blocked).toBe("eval");
  });

  it("truncates the attacker-controlled text it logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await POST(post(JSON.stringify({ "csp-report": { "blocked-uri": "a".repeat(2_000) } })));

    const logged = warn.mock.calls[0][1] as { blocked: string };
    expect(logged.blocked.length).toBeLessThanOrEqual(300);
  });

  it("shrugs off a malformed report rather than erroring", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(POST(post("{not json"))).resolves.toMatchObject({ status: 204 });
    await expect(POST(post("[]"))).resolves.toMatchObject({ status: 204 });
    await expect(POST(post("null"))).resolves.toMatchObject({ status: 204 });
  });
});

import { describe, expect, it } from "vitest";
import {
  BodyTooLargeError,
  declaresOversizedBody,
  readJsonWithinLimit,
  readTextWithinLimit,
} from "./body-limit";

/**
 * Review SEC-M1 / REL-3.4: Next route handlers have no body limit of their own,
 * so every size check in this codebase ran on a body that had already been
 * buffered and JSON-parsed. Free to send, expensive to receive. The point of
 * these tests is that the refusal happens *before* the memory is spent.
 */
const LIMIT = 1_000;

/** A request whose body arrives in chunks, like a real one. */
function streamed(chunks: string[], headers: Record<string, string> = {}): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("http://localhost/x", {
    method: "POST",
    body,
    headers,
    // Required by fetch when the body is a stream.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readTextWithinLimit", () => {
  it("returns a body that fits", async () => {
    const request = streamed(["hello ", "world"]);
    await expect(readTextWithinLimit(request, LIMIT)).resolves.toBe("hello world");
  });

  it("refuses a body on its declared size alone, before reading any of it", async () => {
    // The body here is tiny and perfectly valid; only the header says
    // otherwise. Rejecting it proves the decision was made on the header, which
    // is the cheap path a 500 MB POST has to hit.
    const request = streamed(["ok"], { "content-length": String(LIMIT + 1) });
    await expect(readTextWithinLimit(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  /**
   * Content-Length is a claim. A chunked request omits it, and a hostile client
   * can simply lie — so the stream is where the limit actually holds.
   */
  it("stops mid-stream when a body exceeds the limit despite what it claimed", async () => {
    let chunksSent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksSent++;
        controller.enqueue(new Uint8Array(600));
      },
    });
    const request = new Request("http://localhost/x", {
      method: "POST",
      body,
      // A lie, and an infinite stream behind it.
      headers: { "content-length": "10" },
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readTextWithinLimit(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
    // Two 600-byte chunks pass 1,000 — it must not keep reading a stream that
    // never ends.
    expect(chunksSent).toBeLessThanOrEqual(3);
  });

  it("accepts a body exactly at the limit", async () => {
    const request = streamed(["a".repeat(LIMIT)]);
    await expect(readTextWithinLimit(request, LIMIT)).resolves.toHaveLength(LIMIT);
  });

  it("measures bytes, not characters", async () => {
    // Eight bytes of emoji in four characters; a length check would let this
    // through at a limit of five.
    const request = streamed(["🥃🥃"]);
    await expect(readTextWithinLimit(request, 5)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("handles a buffered body with no stream to meter", async () => {
    const request = new Request("http://localhost/x", { method: "POST", body: "small" });
    await expect(readTextWithinLimit(request, LIMIT)).resolves.toBe("small");
  });
});

describe("declaresOversizedBody", () => {
  it("reads the header, and is not fooled by a missing or junk one", () => {
    const withHeader = (value?: string) =>
      new Request("http://localhost/x", {
        method: "POST",
        headers: value === undefined ? {} : { "content-length": value },
      });

    expect(declaresOversizedBody(withHeader(String(LIMIT + 1)), LIMIT)).toBe(true);
    expect(declaresOversizedBody(withHeader(String(LIMIT)), LIMIT)).toBe(false);
    // Absent (chunked) and unparseable both fall through to the stream check.
    expect(declaresOversizedBody(withHeader(), LIMIT)).toBe(false);
    expect(declaresOversizedBody(withHeader("not-a-number"), LIMIT)).toBe(false);
  });
});

describe("readJsonWithinLimit", () => {
  it("parses a body that fits", async () => {
    const request = streamed([JSON.stringify({ rows: [1, 2] })]);
    await expect(readJsonWithinLimit(request, LIMIT)).resolves.toEqual({ rows: [1, 2] });
  });

  it("returns undefined for a body that is not JSON, so the caller answers 400", async () => {
    const request = streamed(["{not json"]);
    await expect(readJsonWithinLimit(request, LIMIT)).resolves.toBeUndefined();
  });

  it("refuses an oversized body before the parser ever sees it", async () => {
    const request = streamed([`{"pad":"${"x".repeat(LIMIT * 2)}"}`]);
    await expect(readJsonWithinLimit(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

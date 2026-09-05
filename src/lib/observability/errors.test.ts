import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureError,
  captureMessage,
  isErrorMonitoringConfigured,
  redactSensitive,
  setErrorReporterForTests,
  type CapturedEvent,
} from "./errors";

/**
 * These test the redaction and the off-by-default rule, not the SDK.
 *
 * A mock of `@sentry/node` would assert that a function was called, which is
 * the uninteresting half. The question worth asking is what would be IN the
 * payload — specifically whether a share code, an email or a phone hash
 * survived the trip — so the test hook observes the redacted event and the
 * assertions are about its contents.
 */

afterEach(() => {
  setErrorReporterForTests(null);
  delete process.env.SENTRY_DSN;
  vi.restoreAllMocks();
});

function collect(): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  setErrorReporterForTests((e) => events.push(e));
  return events;
}

describe("what leaves this process", () => {
  it("strips a share code, which is a bearer credential", () => {
    const text = "failed fetching https://whaikey.app/s/AbC123_xyz-99 for viewer";
    expect(redactSensitive(text)).toBe(
      "failed fetching https://whaikey.app/s/[redacted] for viewer",
    );
    // The /add/ QR path is the same shape and the same risk.
    expect(redactSensitive("GET /add/Xq7-tokenish")).toBe("GET /add/[redacted]");
  });

  it("strips an email wherever it was interpolated from", () => {
    expect(redactSensitive("user someone@example.com failed")).toBe("user [email] failed");
  });

  it("strips the WHOLE local part, including punctuation RFC 5322 allows", () => {
    // The first version of this test asserted only that "[email]" appeared,
    // which passed while `sam.o'` survived: the regex matched from the `x`
    // onward because its local-part class had no apostrophe. Assert the
    // absence of every fragment, not the presence of the marker.
    const redacted = redactSensitive("no account for sam.o'x+tag@example.co.uk here");
    expect(redacted).toBe("no account for [email] here");
    for (const fragment of ["sam", "o'x", "+tag", "example.co.uk"]) {
      expect(redacted).not.toContain(fragment);
    }
  });

  it("handles the other local-part characters people really have", () => {
    for (const address of [
      "first.last@example.com",
      "o'brien@example.ie",
      "user+tag@sub.example.co.nz",
      "a_b-c!d#e$f%g&h*i@example.org",
    ]) {
      const out = redactSensitive(`from ${address} at 03:00`);
      expect(out).toBe("from [email] at 03:00");
    }
  });

  it("strips the keyed phone hash", () => {
    const hash = "a".repeat(64);
    expect(redactSensitive(`lookup ${hash} missed`)).toBe("lookup [hash] missed");
  });

  it("leaves an ordinary message alone", () => {
    expect(redactSensitive("Cannot read properties of undefined")).toBe(
      "Cannot read properties of undefined",
    );
  });

  it("redacts the message of a captured error, not just the tags", async () => {
    const events = collect();
    await captureError(new Error("boom at https://whaikey.app/s/SECRETCODE"), { where: "api" });
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe("boom at https://whaikey.app/s/[redacted]");
    expect(events[0].message).not.toContain("SECRETCODE");
  });

  it("redacts a captured message too", async () => {
    const events = collect();
    await captureMessage("CSP violation on https://whaikey.app/s/LEAKY", { where: "csp-report" });
    expect(events[0].message).toBe("CSP violation on https://whaikey.app/s/[redacted]");
  });
});

describe("off unless the owner turns it on", () => {
  it("reports nothing configured without a DSN", () => {
    expect(isErrorMonitoringConfigured()).toBe(false);
  });

  it("is configured once a DSN is set", () => {
    process.env.SENTRY_DSN = "https://key@example.ingest.sentry.io/1";
    expect(isErrorMonitoringConfigured()).toBe(true);
  });

  it("never throws out of captureError, whatever it is handed", async () => {
    // Reporting an error must not be able to become the error. The third one
    // throws when it is stringified — the first draft of this test used a
    // throwing `message` getter, which `String(err)` never reads, so it passed
    // without exercising anything.
    const hostile = {
      toString() {
        throw new Error("nice try");
      },
    };
    // With a hook installed, so the message really is computed — without one,
    // `testHook?.(...)` short-circuits and evaluates none of its arguments.
    collect();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(captureError(undefined)).resolves.toBeUndefined();
    await expect(captureError("a string")).resolves.toBeUndefined();
    await expect(captureError(hostile)).resolves.toBeUndefined();
  });
});

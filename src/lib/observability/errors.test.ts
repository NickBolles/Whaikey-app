import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureError,
  reportingErrors,
  captureMessage,
  isErrorMonitoringConfigured,
  redactSensitive,
  wasAlreadyReported,
  reportInBackground,
  reportMessageInBackground,
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

describe("a database error, which carries the user's own words", () => {
  /** The shape Drizzle throws: message already contains the bound values. */
  function drizzleError(query: string, params: unknown[]): Error {
    const err = new Error(`Failed query: ${query}\nparams: ${params}`);
    Object.assign(err, { query, params });
    return err;
  }

  it("never reports the bound parameters", async () => {
    const events = collect();
    const note = "Tastes of my grandfather's cellar and I cried a bit";
    await captureError(drizzleError("insert into tasting_notes (body) values ($1)", [note]), {
      where: "api",
    });

    const payload = JSON.stringify(events[0]);
    // Asserted as the ABSENCE of every fragment, not the presence of a marker:
    // a redaction test that only checks for "[redacted]" passes while half the
    // secret is still in the string. That mistake is already in this PR once.
    for (const fragment of ["grandfather", "cellar", "cried", note]) {
      expect(payload).not.toContain(fragment);
    }
    /**
     * And explicitly over the STACK, which is the surface this test could not
     * see when it was first written. `CapturedEvent` had no `stack` field, so
     * the loop above stringified an object the note was never on, while
     * `err.stack` — whose first line in Node is `<Name>: <message>` — still
     * carried it. Sentry turned out to parse the stack into frames and never
     * transmit that line, so nothing escaped; the test could not have
     * established that either way, which is the reason it is asserted here
     * now. An assertion is only as good as the surface it can reach.
     */
    expect(events[0].stack).toBeTruthy();
    for (const fragment of ["grandfather", "cellar", "cried", note]) {
      expect(events[0].stack).not.toContain(fragment);
    }
    // Frames survive: they are a file, a function and a position, and they are
    // the reason a report is worth having at all.
    expect(events[0].stack).toMatch(/\n\s+at\s/);
    // The SQL survives: it is the schema rather than the data, and it is most
    // of what makes the report worth having.
    expect(events[0].message).toContain("insert into tasting_notes");
    expect(events[0].message).toContain("1 value(s) withheld");
  });

  it("keeps the schema-shaped parts of the driver error as tags", async () => {
    const events = collect();
    const err = drizzleError("insert into user_profiles (handle) values ($1)", ["sam"]);
    // A Postgres error quotes the offending value in its own message, which is
    // exactly why the cause is dropped rather than chained.
    Object.assign(err, {
      cause: Object.assign(new Error("Key (handle)=(sam) already exists"), {
        code: "23505",
        constraint: "user_profiles_handle_uq",
        table: "user_profiles",
        detail: "Key (handle)=(sam) already exists.",
      }),
    });

    await captureError(err, { where: "api" });

    const payload = JSON.stringify(events[0]);
    expect(payload).not.toContain("already exists");
    expect(events[0].context.tags).toMatchObject({
      db_error: "true",
      db_code: "23505",
      db_constraint: "user_profiles_handle_uq",
      db_table: "user_profiles",
    });
    // `detail` is the field that quotes values, so it is not on the safe list.
    expect(events[0].context.tags).not.toHaveProperty("db_detail");
  });

  it("leaves an ordinary error alone", async () => {
    const events = collect();
    await captureError(new Error("something ordinary broke"), { where: "api" });
    expect(events[0].message).toBe("something ordinary broke");
    expect(events[0].context.tags).toBeUndefined();
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

describe("routes that own their own responses", () => {
  it("reports what a handler throws and rethrows it unchanged", async () => {
    const events = collect();
    const boom = new Error("sweep failed at https://whaikey.app/s/LEAKY");
    await expect(reportingErrors("cron/sweep", async () => { throw boom; })).rejects.toBe(boom);
    // Same error object out — the wrapper adds reporting and changes nothing
    // about the response, which is why these routes can use it at all.
    expect(events).toHaveLength(1);
    expect(events[0].context.where).toBe("cron/sweep");
    expect(events[0].message).toBe("sweep failed at https://whaikey.app/s/[redacted]");
  });

  it("passes a success straight through without reporting", async () => {
    const events = collect();
    await expect(reportingErrors("native/manifest", async () => "ok")).resolves.toBe("ok");
    expect(events).toHaveLength(0);
  });
});

describe("one failure, one report", () => {
  it("marks what it has filed so the instrumentation hook does not file it again", async () => {
    const events = collect();
    const boom = new Error("sweep failed");

    // `reportingErrors` reports and RETHROWS, so the error escapes to Next,
    // which calls `onRequestError` for route handlers as well as renders.
    await expect(reportingErrors("cron/sweep", async () => { throw boom; })).rejects.toBe(boom);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    // That hook asks this before reporting; without it the same failure files
    // twice and pages twice, which is how an alert gets muted.
    expect(wasAlreadyReported(boom)).toBe(true);
    expect(wasAlreadyReported(new Error("a different failure"))).toBe(false);
    // Non-objects cannot be marked and must not throw the check.
    expect(wasAlreadyReported("a string")).toBe(false);
    expect(wasAlreadyReported(null)).toBe(false);
  });
});

/**
 * `after()` throws outside a request scope, which every one of these tests is.
 * That is the fallback path, and the thing worth pinning about it is that it
 * reports ONCE: the obvious spelling of the helper starts the report, lets
 * `after` throw, and starts it again in the catch.
 */
describe("reporting without making the caller wait", () => {
  it("files an error exactly once when there is no request scope", async () => {
    const events = collect();
    reportInBackground(new Error("boom"), { where: "api" });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    // Held briefly: a second report would arrive on the next microtask.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0].context.where).toBe("api");
  });

  it("files a message exactly once, redacted the same way", async () => {
    const events = collect();
    reportMessageInBackground("CSP violation on https://whaikey.app/s/LEAKY", {
      where: "csp-report",
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0].message).not.toContain("LEAKY");
    expect(events[0].level).toBe("warning");
  });

  it("never throws at the call site, whatever the reporter does", () => {
    setErrorReporterForTests(() => {
      throw new Error("the reporter itself is broken");
    });
    // The whole point of the seam: a 500 must not become a crash because
    // monitoring is having a bad day.
    expect(() => reportInBackground(new Error("boom"))).not.toThrow();
  });
});

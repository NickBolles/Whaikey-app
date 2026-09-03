import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as manifestGET } from "./route";

/**
 * docs/NATIVE_APP.md §2.2 and review WP-20. The shell loads the deployed site,
 * so a bad deploy reaches every installed app at once and there is nothing to
 * pin a version against. This endpoint is that floor — and raising it is the
 * only kill switch an app that isn't a store binary can have.
 *
 * No session and no database on purpose: the shell asks before anybody has
 * signed in, and the answer is the same for everyone.
 */
afterEach(() => {
  delete process.env.WHAIKEY_MIN_SHELL_VERSION;
  delete process.env.WHAIKEY_SHELL_NOTICE;
  vi.restoreAllMocks();
});

describe("GET /api/native/manifest", () => {
  it("imposes no floor until one is configured", async () => {
    const body = await (await manifestGET()).json();
    expect(body.minShellVersion).toBe("0.0.0");
    expect(body.notice).toBeNull();
  });

  it("serves the configured floor and notice — the kill switch", async () => {
    process.env.WHAIKEY_MIN_SHELL_VERSION = "1.4.0";
    process.env.WHAIKEY_SHELL_NOTICE = "A bad build went out; please update.";
    const body = await (await manifestGET()).json();
    expect(body).toMatchObject({
      minShellVersion: "1.4.0",
      notice: "A bad build went out; please update.",
    });
  });

  /**
   * A typo removes the floor rather than breaking anything visible, so it
   * falls back to "no floor" and says so loudly: a kill switch that silently
   * isn't one is the whole problem restated.
   */
  it("refuses a floor it cannot parse, and complains", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.WHAIKEY_MIN_SHELL_VERSION = "v1.4";
    const body = await (await manifestGET()).json();
    expect(body.minShellVersion).toBe("0.0.0");
    expect(error).toHaveBeenCalled();
  });

  it("is cacheable, but only briefly — a kill switch has to land in minutes", async () => {
    const res = await manifestGET();
    expect(res.headers.get("cache-control")).toContain("max-age=60");
  });
});

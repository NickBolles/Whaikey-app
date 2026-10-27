import { afterEach, describe, expect, it, vi } from "vitest";

const report = vi.fn();
vi.mock("@/lib/observability/errors", () => ({ reportInBackground: (...a: unknown[]) => report(...a) }));

const { withFallback } = await import("./settle");

afterEach(() => {
  vi.useRealTimers();
  report.mockReset();
});

describe("withFallback", () => {
  it("passes a timely value through", async () => {
    await expect(withFallback(Promise.resolve(3), 0, "t")).resolves.toBe(3);
    expect(report).not.toHaveBeenCalled();
  });

  it("falls back on rejection and reports it", async () => {
    const err = new Error("boom");
    await expect(withFallback(Promise.reject(err), [], "home:x")).resolves.toEqual([]);
    expect(report).toHaveBeenCalledWith(err, { where: "settle:home:x" });
  });

  it("falls back when the work hangs past the limit", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = withFallback(new Promise<number>(() => {}), -1, "home:slow", 6000);
    await vi.advanceTimersByTimeAsync(6001);
    await expect(p).resolves.toBe(-1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("accepts drizzle-style thenables", async () => {
    const thenable = { then: (res: (v: string) => void) => res("rows") } as PromiseLike<string>;
    await expect(withFallback(thenable, "none", "t")).resolves.toBe("rows");
  });
});

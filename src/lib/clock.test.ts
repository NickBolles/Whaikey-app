import { afterEach, describe, expect, it } from "vitest";
import { appNow } from "./clock";

// appNow() is the server's clock; WHAIKEY_FAKE_NOW pins it for the visual
// suite (review REL-8.4).

const original = process.env.WHAIKEY_FAKE_NOW;
afterEach(() => {
  if (original === undefined) delete process.env.WHAIKEY_FAKE_NOW;
  else process.env.WHAIKEY_FAKE_NOW = original;
});

describe("appNow", () => {
  it("is the real clock when nothing is pinned", () => {
    delete process.env.WHAIKEY_FAKE_NOW;
    const before = Date.now();
    const now = appNow().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("returns the pinned instant when WHAIKEY_FAKE_NOW parses", () => {
    process.env.WHAIKEY_FAKE_NOW = "2026-07-19T19:30:00Z";
    expect(appNow().toISOString()).toBe("2026-07-19T19:30:00.000Z");
  });

  it("returns a fresh Date each call, so a caller mutating one cannot move the clock", () => {
    process.env.WHAIKEY_FAKE_NOW = "2026-07-19T19:30:00Z";
    const a = appNow();
    a.setUTCFullYear(1999);
    expect(appNow().toISOString()).toBe("2026-07-19T19:30:00.000Z");
  });

  it("falls back to the real clock rather than an Invalid Date when the pin is garbage", () => {
    process.env.WHAIKEY_FAKE_NOW = "not a date";
    const now = appNow();
    expect(Number.isNaN(now.getTime())).toBe(false);
    expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(5_000);
  });
});

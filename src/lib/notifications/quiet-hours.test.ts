import { describe, expect, it } from "vitest";
import {
  describeQuietWindow,
  formatTimeOfDay,
  isValidTimeOfDay,
  isValidTimeZone,
  isWithinQuietWindow,
  minutesOfDayInZone,
  parseTimeOfDay,
  quietWindowEndsAt,
} from "./quiet-hours";

/** 2026-08-09 is a Sunday in DST for both US zones used below. */
const utc = (hhmm: string) => new Date(`2026-08-09T${hhmm}:00.000Z`);

describe("time parsing", () => {
  it("accepts 24-hour times and rejects everything else", () => {
    expect(isValidTimeOfDay("00:00")).toBe(true);
    expect(isValidTimeOfDay("23:59")).toBe(true);
    expect(isValidTimeOfDay("24:00")).toBe(false);
    expect(isValidTimeOfDay("9:00")).toBe(false);
    expect(isValidTimeOfDay("22:60")).toBe(false);
    expect(isValidTimeOfDay("")).toBe(false);
  });

  it("round-trips through minutes", () => {
    expect(parseTimeOfDay("22:30")).toBe(1350);
    expect(formatTimeOfDay(1350)).toBe("22:30");
    expect(formatTimeOfDay(0)).toBe("00:00");
    // Wraps rather than producing a negative or 25-hour clock.
    expect(formatTimeOfDay(1500)).toBe("01:00");
    expect(formatTimeOfDay(-60)).toBe("23:00");
  });
});

describe("minutesOfDayInZone", () => {
  it("reads wall-clock time in the given zone", () => {
    // 03:00 UTC is 21:00 the previous evening in Denver (UTC-6 in August).
    expect(minutesOfDayInZone(utc("03:00"), "America/Denver")).toBe(21 * 60);
    expect(minutesOfDayInZone(utc("03:00"), "UTC")).toBe(3 * 60);
  });

  it("falls back to UTC for an unusable zone rather than throwing", () => {
    // One bad row must not take down a whole send.
    expect(minutesOfDayInZone(utc("03:00"), "Mars/Olympus_Mons")).toBe(3 * 60);
  });

  it("validates zones", () => {
    expect(isValidTimeZone("America/Denver")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("isWithinQuietWindow", () => {
  const overnight = { start: "22:00", end: "08:00", timeZone: "UTC" };

  it("covers the wrap across midnight", () => {
    expect(isWithinQuietWindow(utc("23:30"), overnight)).toBe(true);
    expect(isWithinQuietWindow(utc("03:00"), overnight)).toBe(true);
    expect(isWithinQuietWindow(utc("07:59"), overnight)).toBe(true);
  });

  it("is half-open — start is quiet, end is not", () => {
    expect(isWithinQuietWindow(utc("22:00"), overnight)).toBe(true);
    expect(isWithinQuietWindow(utc("08:00"), overnight)).toBe(false);
  });

  it("handles a same-day window", () => {
    const daytime = { start: "09:00", end: "17:00", timeZone: "UTC" };
    expect(isWithinQuietWindow(utc("12:00"), daytime)).toBe(true);
    expect(isWithinQuietWindow(utc("08:59"), daytime)).toBe(false);
    expect(isWithinQuietWindow(utc("17:00"), daytime)).toBe(false);
  });

  it("treats a zero-length window as no quiet time, not a full day", () => {
    // Dragging both ends together means "never" — muting an account for 24h
    // would be the worse way to be wrong.
    const zero = { start: "22:00", end: "22:00", timeZone: "UTC" };
    expect(isWithinQuietWindow(utc("22:00"), zero)).toBe(false);
    expect(isWithinQuietWindow(utc("03:00"), zero)).toBe(false);
  });

  it("ignores a malformed window instead of holding everything", () => {
    expect(isWithinQuietWindow(utc("23:00"), { start: "nope", end: "08:00", timeZone: "UTC" })).toBe(
      false,
    );
  });

  it("resolves the same instant differently per zone — the point of per-device windows", () => {
    // 03:00 UTC: 21:00 in Denver (awake), 04:00 in Lisbon (asleep).
    const denver = { ...overnight, timeZone: "America/Denver" };
    const lisbon = { ...overnight, timeZone: "Europe/Lisbon" };
    expect(isWithinQuietWindow(utc("03:00"), denver)).toBe(false);
    expect(isWithinQuietWindow(utc("03:00"), lisbon)).toBe(true);
  });
});

describe("quietWindowEndsAt", () => {
  const overnight = { start: "22:00", end: "08:00", timeZone: "UTC" };

  it("returns null when not currently quiet", () => {
    expect(quietWindowEndsAt(utc("12:00"), overnight)).toBeNull();
  });

  it("returns the next end instant, wrapping past midnight", () => {
    const at = quietWindowEndsAt(utc("23:00"), overnight);
    expect(at?.toISOString()).toBe("2026-08-10T08:00:00.000Z");
  });

  it("returns the same morning when already past midnight", () => {
    const at = quietWindowEndsAt(utc("03:00"), overnight);
    expect(at?.toISOString()).toBe("2026-08-09T08:00:00.000Z");
  });
});

describe("describeQuietWindow", () => {
  it("formats a human 12-hour range", () => {
    expect(describeQuietWindow({ start: "22:00", end: "08:00" })).toBe("10 PM – 8 AM");
    expect(describeQuietWindow({ start: "00:30", end: "12:00" })).toBe("12:30 AM – 12 PM");
  });

  it("passes malformed values through rather than inventing a time", () => {
    expect(describeQuietWindow({ start: "nope", end: "08:00" })).toBe("nope – 8 AM");
  });
});

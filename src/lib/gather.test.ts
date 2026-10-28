import { describe, expect, it } from "vitest";
import { isoDay, pickNextOuting } from "@/lib/gather";

const row = (visitOn: string, state = "open", title = visitOn) => ({ title, distilleryName: null, visitOn, joinCode: `c-${visitOn}`, state });

describe("pickNextOuting", () => {
  const now = new Date("2026-10-27T19:00:00Z");
  it("is the soonest open outing from today on, labelled by day", () => {
    expect(isoDay(now)).toBe("2026-10-27");
    expect(pickNextOuting([row("2026-11-05"), row("2026-10-29"), row("2026-10-20")], now)).toMatchObject({ joinCode: "c-2026-10-29", dayLabel: "Thu, Oct 29" });
    expect(pickNextOuting([row("2026-10-28")], now)?.dayLabel).toBe("Tomorrow");
    expect(pickNextOuting([row("2026-10-27")], now)?.dayLabel).toBe("Today");
  });
  it("skips ended and past outings", () => {
    expect(pickNextOuting([row("2026-10-29", "ended"), row("2026-10-01")], now)).toBeNull();
    expect(pickNextOuting([], now)).toBeNull();
  });
});

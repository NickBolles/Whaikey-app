// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({ loadPlugin: vi.fn(async () => null) }));
import { haptic } from "./haptics";

/** `haptic` is fire-and-forget, so the fallback lands a microtask later. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  Reflect.deleteProperty(navigator, "vibrate");
  vi.restoreAllMocks();
});

function stubVibrate() {
  // Typed parameter so `mock.calls` stays inspectable rather than a `[]` tuple.
  const vibrate = vi.fn((pattern: number | number[]) => pattern !== undefined);
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
  return vibrate;
}

describe("haptic on web", () => {
  it("falls back to navigator.vibrate with a per-moment pattern", async () => {
    const vibrate = stubVibrate();

    haptic("category");
    haptic("intensity-1");
    haptic("intensity-2");
    haptic("intensity-3");
    haptic("lock");
    haptic("success");
    haptic("warning");
    await flush();

    expect(vibrate.mock.calls.map(([pattern]) => pattern)).toEqual([
      8,
      18,
      32,
      [42, 35, 42],
      30,
      60,
      [40, 60, 40],
    ]);
  });

  it("does nothing where vibration is unsupported", async () => {
    // iOS Safari and desktop browsers have no navigator.vibrate at all.
    expect(navigator.vibrate).toBeUndefined();
    expect(() => haptic("success")).not.toThrow();
    await flush();
  });

  it("survives a browser that throws when vibration is blocked", async () => {
    Object.defineProperty(navigator, "vibrate", {
      value: () => {
        throw new Error("blocked by user settings");
      },
      configurable: true,
    });
    expect(() => haptic("category")).not.toThrow();
    await flush();
  });
});

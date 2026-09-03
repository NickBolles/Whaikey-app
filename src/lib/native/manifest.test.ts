import { afterEach, describe, expect, it, vi } from "vitest";
import { checkShellVersion, compareVersions } from "./manifest";

/**
 * docs/NATIVE_APP.md §2.2: the shell renders whatever the deploy sends, so a
 * bad deploy bricks every installed app and there is nothing to pin a version
 * against. This is that floor — and, by raising it, the only kill switch a
 * remote-URL app has.
 */
vi.mock("./platform", () => ({
  loadPlugin: vi.fn(async (load: () => Promise<unknown>) => load()),
  isIos: () => true,
}));

vi.mock("@capacitor/app", () => ({
  App: { getInfo: vi.fn(async () => ({ version: installedVersion })) },
}));

let installedVersion: string | null = "1.2.0";

afterEach(() => {
  installedVersion = "1.2.0";
  vi.restoreAllMocks();
});

function manifest(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ok ? Response.json(body) : new Response(null, { status: 500 })) as unknown as typeof fetch;
}

describe("compareVersions", () => {
  it("orders by component, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.2.1")).toBe(-1);
    // A missing component is a zero, not a failure.
    expect(compareVersions("2", "1.9.9")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });
});

describe("checkShellVersion", () => {
  it("passes a shell that meets the floor", async () => {
    const check = await checkShellVersion(manifest({ minShellVersion: "1.0.0" }));
    expect(check).toMatchObject({ status: "ok", installed: "1.2.0", required: "1.0.0" });
  });

  it("stops a shell below it, with somewhere to go", async () => {
    const check = await checkShellVersion(
      manifest({
        minShellVersion: "1.3.0",
        notice: "A bad build went out; please update.",
        storeUrl: { ios: "https://apps.apple.com/app/id123", android: null },
      }),
    );
    expect(check).toMatchObject({
      status: "update_required",
      required: "1.3.0",
      notice: "A bad build went out; please update.",
      storeUrl: "https://apps.apple.com/app/id123",
    });
  });

  /**
   * Failing closed here would be worse than the outage it prevents: a version
   * check that locks people out whenever the network hiccups is its own bug.
   */
  it("fails open on anything it cannot read", async () => {
    for (const impl of [
      manifest(null, false),
      manifest({}),
      manifest({ minShellVersion: "not-a-version" }),
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    ]) {
      expect((await checkShellVersion(impl)).status).toBe("unknown");
    }
  });

  it("says nothing off-device, where there is no binary to be out of date", async () => {
    installedVersion = null;
    const check = await checkShellVersion(manifest({ minShellVersion: "9.9.9" }));
    expect(check).toMatchObject({ status: "unknown", installed: null });
  });
});

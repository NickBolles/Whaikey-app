// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const router = { back: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { NativeShell } from "@/components/native-shell";
import { clearQueue, enqueuePour, flushPourQueue, queueDepth } from "@/lib/native/offline-queue";

/** The signed-in user; the flush only ever sends pours it can attribute. */
const ME = "user-me";

beforeEach(async () => {
  // Every mount above starts a flush, and the single-flight guard would hand a
  // still-pending one to the next test instead of looking at its queue. Let it
  // settle first; with an empty queue it does nothing.
  await flushPourQueue();
  localStorage.clear();
  await clearQueue();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "Capacitor");
  document.documentElement.classList.remove("native-app");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("NativeShell", () => {
  it("renders nothing", () => {
    const { container } = render(<NativeShell userId={ME} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does no native work on the web", () => {
    // The web app must not pay for the *native* parts of the shell — no marker
    // class, no plugin work, no navigation. The offline pour flush is the one
    // deliberate exception (below): web and PWA users queue pours too.
    render(<NativeShell userId={ME} />);
    expect(document.documentElement).not.toHaveClass("native-app");
    expect(router.back).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("marks the document as native so CSS can target the shell", () => {
    Object.defineProperty(window, "Capacitor", {
      value: { getPlatform: () => "ios", isNativePlatform: () => true },
      configurable: true,
      writable: true,
    });

    const { unmount } = render(<NativeShell userId={ME} />);
    expect(document.documentElement).toHaveClass("native-app");

    unmount();
    expect(document.documentElement).not.toHaveClass("native-app");
  });
});

/**
 * REL-4.1 was a P0 for one reason: the flush lived inside the shell's
 * `isNativeApp()` branch, so a web or PWA user was told "saved on your phone"
 * and the pour was never sent. jsdom has no `window.Capacitor`, so everything
 * here runs the web path — the one that was broken.
 */
describe("NativeShell offline pour sync on the web", () => {
  function mockFetch() {
    const fn = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("flushes queued pours on mount even though this is not the native app", async () => {
    await enqueuePour({ body: { bottleId: "ardbeg-10" }, bottleName: "Ardbeg 10", userId: ME });
    const fetchMock = mockFetch();

    render(<NativeShell userId={ME} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/pours", expect.anything()));
    await waitFor(async () => expect(await queueDepth()).toBe(0));
    // A synced pour only reaches My Bar and the journal once the server data is
    // re-fetched, so a successful flush has to refresh.
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("flushes again when the connection comes back", async () => {
    const fetchMock = mockFetch();
    render(<NativeShell userId={ME} />);

    await enqueuePour({ body: { bottleId: "springbank-15" }, bottleName: "Springbank 15", userId: ME });
    window.dispatchEvent(new Event("online"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await queueDepth()).toBe(0));
  });

  it("flushes when the tab comes back to the foreground", async () => {
    const fetchMock = mockFetch();
    render(<NativeShell userId={ME} />);

    await enqueuePour({ body: { bottleId: "lagavulin-16" }, bottleName: "Lagavulin 16", userId: ME });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await queueDepth()).toBe(0));
  });

  it("does not send while the browser reports no connection", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await enqueuePour({ body: { bottleId: "ardbeg-10" }, bottleName: "Ardbeg 10", userId: ME });
    const fetchMock = mockFetch();

    render(<NativeShell userId={ME} />);

    // Give the mount effect a turn to do the wrong thing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(queueDepth()).resolves.toBe(1);
  });
});

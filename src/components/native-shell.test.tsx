// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const router = { back: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { NativeShell } from "@/components/native-shell";
import { ToastProvider } from "@/components/toast";
import { clearQueue, enqueuePour, flushPourQueue, queueDepth } from "@/lib/native/offline-queue";

/** The signed-in user; the flush only ever sends pours it can attribute. */
const ME = "user-me";

/** The root layout mounts the shell inside the app's toast region. */
function renderShell(ui: React.ReactElement) {
  return render(ui, { wrapper: ToastProvider });
}

function notifications() {
  return within(screen.getByRole("region", { name: "Notifications" }));
}

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
  it("renders nothing of its own", () => {
    const { container } = renderShell(<NativeShell userId={ME} />);
    // The only thing on screen is the (empty) toast region the wrapper adds.
    expect(container.children).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent("");
  });

  it("does no native work on the web", () => {
    // The web app must not pay for the *native* parts of the shell — no marker
    // class, no plugin work, no navigation. The offline pour flush is the one
    // deliberate exception (below): web and PWA users queue pours too.
    renderShell(<NativeShell userId={ME} />);
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

    const { unmount } = renderShell(<NativeShell userId={ME} />);
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

    renderShell(<NativeShell userId={ME} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/pours", expect.anything()));
    await waitFor(async () => expect(await queueDepth()).toBe(0));
    // A synced pour only reaches My Bar and the journal once the server data is
    // re-fetched, so a successful flush has to refresh.
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("flushes again when the connection comes back", async () => {
    const fetchMock = mockFetch();
    renderShell(<NativeShell userId={ME} />);

    await enqueuePour({ body: { bottleId: "springbank-15" }, bottleName: "Springbank 15", userId: ME });
    window.dispatchEvent(new Event("online"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await queueDepth()).toBe(0));
  });

  it("flushes when the tab comes back to the foreground", async () => {
    const fetchMock = mockFetch();
    renderShell(<NativeShell userId={ME} />);

    await enqueuePour({ body: { bottleId: "lagavulin-16" }, bottleName: "Lagavulin 16", userId: ME });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(async () => expect(await queueDepth()).toBe(0));
  });

  it("says so when pours logged offline have been sent", async () => {
    await enqueuePour({ body: { bottleId: "ardbeg-10" }, bottleName: "Ardbeg 10", userId: ME });
    await enqueuePour({ body: { bottleId: "lagavulin-16" }, bottleName: "Lagavulin 16", userId: ME });
    mockFetch();

    renderShell(<NativeShell userId={ME} />);

    // "Saved on your phone" was a promise; this is it being kept, out loud.
    await waitFor(() => expect(notifications().getByText("Synced 2 pours logged offline.")).toBeInTheDocument());
  });

  it("tells the user when the server keeps refusing a queued pour, and that it is kept", async () => {
    await enqueuePour({ body: { bottleId: "ardbeg-10" }, bottleName: "Ardbeg 10", userId: ME });
    const fetchMock = vi.fn(async () => new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    renderShell(<NativeShell userId={ME} />);
    // Each flush spends one attempt on a 4xx; the fifth quarantines it.
    for (let attempt = 1; attempt <= 5; attempt++) {
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(attempt));
      if (attempt < 5) window.dispatchEvent(new Event("online"));
    }

    await waitFor(() =>
      expect(
        notifications().getByText("1 pour logged offline couldn't be saved. They're kept on this device."),
      ).toBeInTheDocument(),
    );
    await expect(queueDepth()).resolves.toBe(0);
  });

  it("mentions pours held for another author once, not on every flush", async () => {
    // No userId: queued by a release that recorded no author (REL-4.1 status).
    await enqueuePour({ body: { bottleId: "ardbeg-10" }, bottleName: "Ardbeg 10" });
    mockFetch();

    renderShell(<NativeShell userId={ME} />);
    const message = /1 pour logged offline on this device is waiting for the account that logged it/;
    await waitFor(() => expect(notifications().getByText(message)).toBeInTheDocument());

    // Dismiss it, then trigger another flush: the same held pour is not news.
    fireEvent.click(notifications().getByRole("button", { name: "Dismiss notification" }));
    await waitFor(() => expect(notifications().queryByText(message)).not.toBeInTheDocument());
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPourQueue(ME);
    expect(notifications().queryByText(message)).not.toBeInTheDocument();
    await expect(queueDepth()).resolves.toBe(1);
  });

  it("does not send while the browser reports no connection", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await enqueuePour({ body: { bottleId: "ardbeg-10" }, bottleName: "Ardbeg 10", userId: ME });
    const fetchMock = mockFetch();

    renderShell(<NativeShell userId={ME} />);

    // Give the mount effect a turn to do the wrong thing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(queueDepth()).resolves.toBe(1);
  });
});

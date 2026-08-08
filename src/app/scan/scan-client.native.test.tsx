// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * The native half of the scanner (docs/NATIVE_APP.md §3.1). The web engine is
 * covered in scan-client.test.tsx; this file asserts the swap itself — that a
 * device uses MLKit instead of `getUserMedia`, and that the event stream is
 * de-duplicated, which the web engine's polling loop got for free.
 */
const { startNativeScan, isNativeTorchAvailable, setNativeTorch } = vi.hoisted(() => ({
  startNativeScan: vi.fn(),
  isNativeTorchAvailable: vi.fn(async () => false),
  setNativeTorch: vi.fn(async () => false),
}));

vi.mock("@/lib/native/barcode", () => ({
  startNativeScan,
  isNativeTorchAvailable,
  setNativeTorch,
}));

import { ScanClient } from "./scan-client";

const UPC = "080244002145"; // valid check digit
const OTHER_UPC = "088004021535";

/** Captures the callback MLKit would drive, so tests can emit barcodes. */
let emit: ((raw: string) => void) | null = null;
const stop = vi.fn(async () => {});

beforeEach(() => {
  Object.defineProperty(window, "Capacitor", {
    value: { getPlatform: () => "ios", isNativePlatform: () => true },
    configurable: true,
    writable: true,
  });
  startNativeScan.mockImplementation(async (options: { onBarcode: (raw: string) => void }) => {
    emit = options.onBarcode;
    return { stop };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ upc: UPC, matches: [], candidates: [], externalName: null }),
    ),
  );
});

afterEach(() => {
  cleanup();
  emit = null;
  Reflect.deleteProperty(window, "Capacitor");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function scanRequests() {
  const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.filter(([url]) => String(url) === "/api/scan/upc");
}

describe("ScanClient on a device", () => {
  it("scans through MLKit instead of the web camera", async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });

    const { container } = render(<ScanClient />);

    await waitFor(() => expect(startNativeScan).toHaveBeenCalled());
    expect(startNativeScan.mock.calls[0][0]).toMatchObject({ facing: "back" });

    // The OS renders the camera behind the WebView, so there is no <video> to
    // drive and getUserMedia must never be reached.
    await waitFor(() => expect(container.querySelector("video")).toBeNull());
    expect(getUserMedia).not.toHaveBeenCalled();

    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("queues a barcode pushed up from the plugin", async () => {
    render(<ScanClient />);
    await waitFor(() => expect(emit).not.toBeNull());

    emit?.(UPC);

    await waitFor(() => expect(scanRequests()).toHaveLength(1));
    expect(JSON.parse(String(scanRequests()[0][1]?.body))).toEqual({ upc: UPC });
    // The stubbed lookup finds nothing, so the item lands in the review queue —
    // the same path the web engine takes for an unknown barcode.
    expect(await screen.findByRole("button", { name: "Needs you" })).toBeInTheDocument();
  });

  it("collapses the repeated events MLKit emits for one barcode", async () => {
    render(<ScanClient />);
    await waitFor(() => expect(emit).not.toBeNull());

    // MLKit reports whatever is in frame many times a second; without the repeat
    // window the queue would fill with copies of a single bottle.
    emit?.(UPC);
    emit?.(UPC);
    emit?.(UPC);

    await waitFor(() => expect(scanRequests()).toHaveLength(1));

    // A different bottle still gets through immediately.
    emit?.(OTHER_UPC);
    await waitFor(() => expect(scanRequests()).toHaveLength(2));
  });

  it("stops the native scan when the screen unmounts", async () => {
    const { unmount } = render(<ScanClient />);
    await waitFor(() => expect(startNativeScan).toHaveBeenCalled());

    unmount();

    // Leaving the camera running would keep the page transparent over a dead
    // scanner and hold the hardware open.
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it("falls back to the web engine when the device cannot scan natively", async () => {
    startNativeScan.mockResolvedValue(null);
    const getUserMedia = vi.fn(async () => {
      throw new Error("no camera in jsdom");
    });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });

    render(<ScanClient />);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    Reflect.deleteProperty(navigator, "mediaDevices");
  });
});

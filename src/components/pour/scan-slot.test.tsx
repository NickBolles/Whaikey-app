// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/native/platform", () => ({ isNativeApp: () => false }));
vi.mock("@/lib/native/barcode", () => ({ startNativeScan: vi.fn(async () => null) }));
vi.mock("@/lib/native/haptics", () => ({ haptic: vi.fn() }));
const identifyLabel = vi.fn();
vi.mock("@/lib/label-scan", () => ({ identifyLabel: (...args: unknown[]) => identifyLabel(...args) }));

import { PourScanSlot } from "./scan-slot";

const blantons = { id: "blantons", name: "Blanton's Original", distillery: "Buffalo Trace", category: "bourbon", region: "Kentucky", abv: 46.5, ageYears: null };

type Handler = (url: string, init?: RequestInit) => unknown;
function stubFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = handler(url, init);
    if (body instanceof Response) return body;
    if (body === undefined) return { ok: true, status: 200, json: async () => ({}) } as Response;
    if (typeof body === "object" && body && "status" in body && "json" in body) return body as Response;
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** A live camera whose detector sees `codes` on every frame. */
function fakeCamera(codes: string[] | null) {
  const stop = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
  if (codes) {
    vi.stubGlobal(
      "BarcodeDetector",
      class {
        async detect() {
          return codes.map((rawValue) => ({ rawValue }));
        }
      },
    );
  }
  return { stop };
}

beforeEach(() => {
  identifyLabel.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("PourScanSlot — no camera", () => {
  it("degrades to typing and recents, never a dead end", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    stubFetch((url) => (url.startsWith("/api/pours") ? { pours: [{ bottleId: "b1", bottleName: "Eagle Rare" }, { bottleId: "b1", bottleName: "Eagle Rare" }, { bottleId: "b2", bottleName: "Lagavulin 16" }] } : undefined));
    const onPick = vi.fn();
    render(<PourScanSlot onPick={onPick} missingNotice />);
    expect(await screen.findByText(/Camera is off/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn’t load that bottle/);
    expect(screen.getByRole("button", { name: /Try camera again/ })).toBeInTheDocument();

    // Recents are de-duplicated and one tap picks.
    const recents = await screen.findByRole("list", { name: "Recent bottles" });
    expect(recents.querySelectorAll("li")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Lagavulin 16" }));
    expect(onPick).toHaveBeenCalledWith({ id: "b2", name: "Lagavulin 16" }, { via: "recent" });
  });

  it("type-to-search picks a result, and says so when nothing matches", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    stubFetch((url) => {
      if (url.includes("q=blant")) return { results: [{ ...blantons, distillery: { name: "Buffalo Trace" } }] };
      if (url.includes("q=zzz")) return { results: [] };
      return undefined;
    });
    const onPick = vi.fn();
    render(<PourScanSlot onPick={onPick} />);
    const input = screen.getByPlaceholderText(/or type a name/);

    fireEvent.change(input, { target: { value: "b" } });
    expect(screen.queryByRole("list", { name: "Search results" })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "blant" } });
    const results = await screen.findByRole("list", { name: "Search results" }, { timeout: 2000 });
    expect(results).toHaveTextContent("Buffalo Trace · Kentucky · 46.5%");
    fireEvent.click(screen.getByRole("button", { name: /Blanton's Original/ }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "blantons", distillery: "Buffalo Trace" }), { via: "search" });

    fireEvent.change(input, { target: { value: "zzz" } });
    expect(await screen.findByText(/No bottles match “zzz”/, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it("a failing search says so", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    stubFetch((url) => (url.includes("/api/bottles/search") ? ({ ok: false, status: 500, json: async () => ({}) } as Response) : undefined));
    render(<PourScanSlot onPick={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/or type a name/), { target: { value: "eagle" } });
    expect(await screen.findByText(/Search is unavailable/, {}, { timeout: 2000 })).toBeInTheDocument();
  });
});

describe("PourScanSlot — live barcode", () => {
  it("an exact match picks straight away, skipping a lot number in the same frame", async () => {
    fakeCamera(["LOT080244002145", "080244003302"]);
    const fetchMock = stubFetch((url) => (url === "/api/scan/upc" ? { upc: "080244003302", matches: [blantons], candidates: [], externalName: null } : undefined));
    const onPick = vi.fn();
    render(<PourScanSlot onPick={onPick} />);
    await waitFor(() => expect(onPick).toHaveBeenCalled(), { timeout: 3000 });
    expect(onPick).toHaveBeenCalledWith(blantons, { via: "barcode", alternatives: [] });
    const lookups = fetchMock.mock.calls.filter(([u]) => String(u) === "/api/scan/upc").map(([, i]) => JSON.parse(String(i?.body)).upc);
    expect(lookups).toEqual(["080244003302"]);
  });

  it("unverified suggestions are offered, never auto-picked", async () => {
    fakeCamera(["080244003302"]);
    stubFetch((url) => (url === "/api/scan/upc" ? { upc: "080244003302", matches: [], candidates: [blantons], externalName: "BLANTONS SB" } : undefined));
    const onPick = vi.fn();
    render(<PourScanSlot onPick={onPick} />);
    const group = await screen.findByRole("group", { name: "Is it one of these?" }, { timeout: 3000 });
    expect(group).toHaveTextContent("BLANTONS SB");
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Blanton's Original/ }));
    expect(onPick).toHaveBeenCalledWith(blantons, { via: "barcode" });
  });

  it("an unknown barcode points at teaching the scanner", async () => {
    fakeCamera(["080244003302"]);
    stubFetch((url) => (url === "/api/scan/upc" ? { upc: "080244003302", matches: [], candidates: [], externalName: null } : undefined));
    render(<PourScanSlot onPick={vi.fn()} />);
    expect(await screen.findByText(/We don’t know barcode 080244003302 yet/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "teach the scanner" })).toHaveAttribute("href", "/scan");
  });

  it("a lookup failure falls back to typing", async () => {
    fakeCamera(["080244003302"]);
    stubFetch((url) => (url === "/api/scan/upc" ? ({ ok: false, status: 500, json: async () => ({}) } as Response) : undefined));
    render(<PourScanSlot onPick={vi.fn()} />);
    expect(await screen.findByText(/Couldn't look that barcode up/, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("without a barcode detector, Snap label reads the label and offers its matches", async () => {
    fakeCamera(null);
    stubFetch(() => undefined);
    identifyLabel.mockResolvedValue({ via: "ocr", candidates: [blantons], guess: "Blanton's", aiUnavailable: null });
    const onPick = vi.fn();
    render(<PourScanSlot onPick={onPick} />);
    expect(await screen.findByText("Snap the label to identify it.")).toBeInTheDocument();
    // jsdom has no frames; give the video a size so the snap has something to draw.
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 640 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 480 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,AAAA");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Snap label/ }));
    });
    expect(identifyLabel).toHaveBeenCalledWith("data:image/jpeg;base64,AAAA", "image/jpeg");
    fireEvent.click(await screen.findByRole("button", { name: /Blanton's Original/ }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "blantons" }), { via: "label" });
  });

  it("a label it can't place says what it read", async () => {
    fakeCamera(null);
    stubFetch(() => undefined);
    identifyLabel.mockResolvedValue({ via: "ai", candidates: [], guess: "Mystery Malt", aiUnavailable: null });
    render(<PourScanSlot onPick={vi.fn()} />);
    await screen.findByText("Snap the label to identify it.");
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 640 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 480 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,AAAA");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Snap label/ }));
    });
    expect(screen.getByText(/The label reads “Mystery Malt”/)).toBeInTheDocument();
  });

  it("stops the camera when the slot goes away", async () => {
    const { stop } = fakeCamera(null);
    stubFetch(() => undefined);
    const view = render(<PourScanSlot onPick={vi.fn()} />);
    await screen.findByText("Snap the label to identify it.");
    view.unmount();
    expect(stop).toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/native/platform", () => ({ isNativeApp: () => false }));
vi.mock("@/lib/native/barcode", () => ({ startNativeScan: vi.fn(async () => null) }));
vi.mock("@/lib/native/haptics", () => ({ haptic: vi.fn() }));
const identifyLabel = vi.fn();
vi.mock("@/lib/label-scan", () => ({ identifyLabel: (...args: unknown[]) => identifyLabel(...args) }));

import { CAMERA_AUTO_PAUSE_MS, CAMERA_MAX_SESSION_MS, PourScanSlot, teachMessage } from "./scan-slot";

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
    const fetchMock = stubFetch((url) => (url === "/api/scan/upc" ? { upc: "080244003302", matches: [], candidates: [blantons], externalName: "BLANTONS SB" } : undefined));
    const onPick = vi.fn();
    render(<PourScanSlot onPick={onPick} />);
    const group = await screen.findByRole("group", { name: "Is it one of these?" }, { timeout: 3000 });
    expect(group).toHaveTextContent("BLANTONS SB");
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Blanton's Original/ }));
    expect(onPick).toHaveBeenCalledWith(blantons, { via: "barcode" });
    // The pick teaches the barcode, without shelving anything.
    const confirm = fetchMock.mock.calls.find(([u]) => String(u) === "/api/scan/confirm");
    expect(JSON.parse(String(confirm?.[1]?.body))).toEqual({ upc: "080244003302", bottleId: "blantons" });
  });

  it("an unknown barcode gets a breakdown card: what was read, Pick bottle, and Teach this barcode", async () => {
    fakeCamera(["080244003302"]);
    const fetchMock = stubFetch((url) => {
      if (url === "/api/scan/upc") return { upc: "080244003302", matches: [], candidates: [], externalName: "BLANTONS SB 750" };
      if (url.includes("q=BLANTONS")) return { results: [blantons] };
      if (url === "/api/scan/confirm") return { teach: { state: "pending", confirmations: 1, required: 2, taught: false } };
      return undefined;
    });
    const onPick = vi.fn();
    const onNotice = vi.fn();
    render(<PourScanSlot onPick={onPick} onNotice={onNotice} />);
    const card = await screen.findByRole("group", { name: "Unknown barcode" }, { timeout: 3000 });
    expect(card).toHaveTextContent("080244003302");
    expect(card).toHaveTextContent("BLANTONS SB 750");
    expect(card).toHaveTextContent(/not read yet/);
    expect(screen.getByRole("switch", { name: /Teach this barcode/ })).toHaveAttribute("aria-checked", "true");

    // Pick bottle searches with what the barcode lookup said and focuses the box.
    fireEvent.click(screen.getByRole("button", { name: /Pick bottle/ }));
    expect(screen.getByPlaceholderText(/or type a name/)).toHaveFocus();
    fireEvent.click(await screen.findByRole("button", { name: /Blanton's Original/ }, { timeout: 2000 }));
    expect(onPick).toHaveBeenCalledWith(blantons, { via: "search" });
    const confirm = fetchMock.mock.calls.find(([u]) => String(u) === "/api/scan/confirm");
    expect(JSON.parse(String(confirm?.[1]?.body))).toEqual({ upc: "080244003302", bottleId: "blantons" });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/1 more confirmation adds it for everyone/)));
    expect(screen.queryByRole("group", { name: "Unknown barcode" })).not.toBeInTheDocument();
  });

  it("with Teach switched off, picking for an unknown barcode teaches nothing", async () => {
    fakeCamera(["080244003302"]);
    const fetchMock = stubFetch((url) => {
      if (url === "/api/scan/upc") return { upc: "080244003302", matches: [], candidates: [], externalName: null };
      if (url.startsWith("/api/pours")) return { pours: [{ bottleId: "b2", bottleName: "Lagavulin 16" }] };
      return undefined;
    });
    const onPick = vi.fn();
    render(<PourScanSlot onPick={onPick} />);
    await screen.findByRole("group", { name: "Unknown barcode" }, { timeout: 3000 });
    fireEvent.click(screen.getByRole("switch", { name: /Teach this barcode/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Lagavulin 16" }));
    expect(onPick).toHaveBeenCalledWith({ id: "b2", name: "Lagavulin 16" }, { via: "recent" });
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/scan/confirm")).toBe(false);
  });

  it("Read the label on the card shows the OCR text and its matches teach the barcode", async () => {
    fakeCamera(["080244003302"]);
    const fetchMock = stubFetch((url) =>
      url === "/api/scan/upc" ? { upc: "080244003302", matches: [], candidates: [], externalName: null } : undefined,
    );
    identifyLabel.mockResolvedValue({ via: "ocr", candidates: [blantons], guess: "Blanton's Single Barrel", aiUnavailable: null });
    const onPick = vi.fn();
    render(<PourScanSlot onPick={onPick} />);
    await screen.findByRole("group", { name: "Unknown barcode" }, { timeout: 3000 });
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 640 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 480 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,AAAA");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Read the label/ }));
    });
    expect(screen.getByRole("group", { name: "Unknown barcode" })).toHaveTextContent("“Blanton's Single Barrel”");
    fireEvent.click(await screen.findByRole("button", { name: /Blanton's Original/ }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "blantons" }), { via: "label" });
    const bodies = fetchMock.mock.calls.filter(([u]) => String(u) === "/api/scan/confirm").map(([, i]) => JSON.parse(String(i?.body)));
    expect(bodies).toEqual([{ upc: "080244003302", bottleId: "blantons" }]);
  });

  it("a lookup failure falls back to typing", async () => {
    fakeCamera(["080244003302"]);
    stubFetch((url) => (url === "/api/scan/upc" ? ({ ok: false, status: 500, json: async () => ({}) } as Response) : undefined));
    render(<PourScanSlot onPick={vi.fn()} />);
    expect(await screen.findByText(/Couldn't look that barcode up/, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("without a barcode detector, Snap label reads the label and offers its matches", async () => {
    fakeCamera(null);
    const fetchMock = stubFetch(() => undefined);
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
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === "/api/scan/confirm" && JSON.parse(String(i?.body)).via === "ocr")).toBe(true);
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

describe("PourScanSlot — keep scanning", () => {
  it("offers Keep scanning while the camera runs; Stop camera turns it off and stops the stream", async () => {
    const { stop } = fakeCamera(null);
    stubFetch(() => undefined);
    const onKeep = vi.fn();
    const view = render(<PourScanSlot onPick={vi.fn()} keepScanning={false} onKeepScanningChange={onKeep} />);
    const toggle = await screen.findByRole("button", { name: /Keep scanning/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onKeep).toHaveBeenLastCalledWith(true);
    view.rerender(<PourScanSlot onPick={vi.fn()} keepScanning onKeepScanningChange={onKeep} />);
    fireEvent.click(screen.getByRole("button", { name: /Stop camera/ }));
    expect(stop).toHaveBeenCalled();
    expect(onKeep).toHaveBeenLastCalledWith(false);
    expect(await screen.findByText(/Camera paused to save battery/)).toBeInTheDocument();
  });

  it("compact mode is just the viewfinder, and a new round lets the same bottle be read again", async () => {
    fakeCamera(["080244003302"]);
    stubFetch((url) => (url === "/api/scan/upc" ? { upc: "080244003302", matches: [blantons], candidates: [], externalName: null } : undefined));
    const onPick = vi.fn();
    const view = render(<PourScanSlot onPick={onPick} compact keepScanning onKeepScanningChange={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/or type a name/)).not.toBeInTheDocument();
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1), { timeout: 3000 });
    // Same code in frame: not read twice in one round.
    await new Promise((r) => setTimeout(r, 700));
    expect(onPick).toHaveBeenCalledTimes(1);
    view.rerender(<PourScanSlot onPick={onPick} compact keepScanning onKeepScanningChange={vi.fn()} round={1} />);
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it("pauses after the idle timeout and caps a session even while reads keep coming", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { stop } = fakeCamera(null);
      stubFetch(() => undefined);
      render(<PourScanSlot onPick={vi.fn()} keepScanning onKeepScanningChange={vi.fn()} />);
      await screen.findByRole("button", { name: /Stop camera/ });
      await act(async () => {
        vi.advanceTimersByTime(CAMERA_AUTO_PAUSE_MS + 10);
      });
      expect(stop).toHaveBeenCalled();
      expect(screen.getByText(/tap Resume for the next bottle/)).toBeInTheDocument();
      expect(CAMERA_MAX_SESSION_MS).toBeGreaterThan(CAMERA_AUTO_PAUSE_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("teachMessage", () => {
  it("names what the confirmation did", () => {
    expect(teachMessage("X", { teach: { state: "promoted", confirmations: 2, required: 2, taught: true } })).toMatch(/You taught Whaikey/);
    expect(teachMessage("X", { teach: { state: "pending", confirmations: 1, required: 2, taught: false } })).toMatch(/1 more confirmation /);
    expect(teachMessage("X", { teach: { state: "pending", confirmations: 2, required: 2, taught: false } })).toMatch(/waiting for review/);
    expect(teachMessage("X", null)).toMatch(/barcode noted/);
  });
});

describe("PourScanSlot — stale suggestions", () => {
  it("an exact match clears the previous barcode's suggestions", async () => {
    let call = 0;
    const codes = ["080244003302"];
    fakeCamera(codes);
    stubFetch((url) => {
      if (url !== "/api/scan/upc") return undefined;
      call += 1;
      return call === 1
        ? { upc: "080244003302", matches: [], candidates: [blantons], externalName: null }
        : { upc: "088004021344", matches: [{ ...blantons, id: "eagle", name: "Eagle Rare 10" }], candidates: [], externalName: null };
    });
    const onPick = vi.fn();
    render(<PourScanSlot onPick={onPick} compact keepScanning onKeepScanningChange={vi.fn()} />);
    await screen.findByRole("group", { name: "Is it one of these?" }, { timeout: 3000 });
    codes[0] = "088004021344";
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "eagle" }), expect.anything()), { timeout: 3000 });
    expect(screen.queryByRole("group", { name: "Is it one of these?" })).not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScanClient } from "./scan-client";

const UPC = "080244002145"; // valid check digit
const EAGLE = {
  id: "eagle-rare-10",
  name: "Eagle Rare 10 Year",
  category: "bourbon",
  region: "Kentucky",
  ageYears: 10,
  abv: 45,
  msrp: 40,
  avgPrice: 55,
  distillery: "Buffalo Trace Distillery",
};
const STAGG = { ...EAGLE, id: "stagg", name: "Stagg", ageYears: null };

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const result = handler(url, init);
    if (result instanceof Response) return result;
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function confirmResponse(bottle: { id: string; name: string }, ubId: string) {
  return new Response(
    JSON.stringify({ mapping: { upc: UPC }, userBottle: { id: ubId }, bottle }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

function scanMiss() {
  return { upc: UPC, matches: [], candidates: [], externalName: null };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ScanClient (manual fallback mode)", () => {
  it("offers manual entry when the camera is unavailable", () => {
    mockFetch(() => scanMiss());
    render(<ScanClient />);
    expect(screen.getByText(/camera scanning isn't available/i)).toBeTruthy();
    expect(screen.getByLabelText(/barcode number/i)).toBeTruthy();
    expect(screen.getByText(/scanned this session \(0\)/i)).toBeTruthy();
  });

  it("rejects an invalid code inline without calling the API", async () => {
    const fetchMock = mockFetch(() => scanMiss());
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.type(screen.getByLabelText(/barcode number/i), "12345");
    await user.click(screen.getByRole("button", { name: "Scan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/doesn't look like/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto-adds a uniquely matched barcode in the background", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    mockFetch((url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.includes("/api/scan/upc"))
        return { upc: UPC, matches: [EAGLE], candidates: [], externalName: null };
      if (url.includes("/api/scan/confirm")) return confirmResponse(EAGLE, "ub-1");
      throw new Error(`unexpected fetch ${url}`);
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.type(screen.getByLabelText(/barcode number/i), UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));

    expect(await screen.findByText(/added eagle rare 10 year/i)).toBeTruthy();
    expect(screen.getByText(/scanned this session \(1\)/i)).toBeTruthy();
    expect(screen.getByText("Eagle Rare 10 Year")).toBeTruthy();

    const confirm = calls.find((c) => c.url.includes("/api/scan/confirm"));
    expect(confirm?.body).toEqual({ upc: UPC, bottleId: EAGLE.id, relationship: "own" });
  });

  it("sends the selected relationship with the confirmation", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    mockFetch((url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.includes("/api/scan/upc"))
        return { upc: UPC, matches: [EAGLE], candidates: [], externalName: null };
      return confirmResponse(EAGLE, "ub-2");
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.click(screen.getByRole("radio", { name: /wishlist/i }));
    await user.type(screen.getByLabelText(/barcode number/i), UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));

    await screen.findByText(/scanned this session \(1\)/i);
    const confirm = calls.find((c) => c.url.includes("/api/scan/confirm"));
    expect(confirm?.body).toMatchObject({ relationship: "wishlist" });
  });

  it("queues an ambiguous barcode as needs-you, resolved via the picker sheet", async () => {
    mockFetch((url) => {
      if (url.includes("/api/scan/upc"))
        return { upc: UPC, matches: [EAGLE, STAGG], candidates: [], externalName: null };
      return confirmResponse(STAGG, "ub-3");
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.type(screen.getByLabelText(/barcode number/i), UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));

    // The item lands in the queue asking for review — nothing blocks scanning.
    const needsYou = await screen.findByRole("button", { name: /needs you/i });
    expect(screen.getByText(/1 need you/i)).toBeTruthy();

    await user.click(needsYou);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/which bottle is this/i);
    expect(dialog).toHaveTextContent("Stagg");

    const pickButtons = screen.getAllByRole("button", { name: /^this one$/i });
    await user.click(pickButtons[1]);

    expect(await screen.findByText(/scanned this session \(1\)/i)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps accepting scans while earlier ones are still resolving", async () => {
    // First scan's resolution hangs until we release it; the second completes.
    let releaseFirst: (v: Response) => void = () => {};
    const firstGate = new Promise<Response>((resolve) => (releaseFirst = resolve));
    let upcCalls = 0;
    const SECOND = "096749001613";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/scan/upc")) {
          upcCalls += 1;
          if (upcCalls === 1) return firstGate;
          return Response.json({
            upc: SECOND,
            matches: [STAGG],
            candidates: [],
            externalName: null,
          });
        }
        return confirmResponse(STAGG, "ub-4");
      }),
    );
    const user = userEvent.setup();
    render(<ScanClient />);

    const input = screen.getByLabelText(/barcode number/i);
    await user.type(input, UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByText(/1 identifying/i)).toBeTruthy();

    // Second scan goes straight through while the first is still in flight.
    await user.type(input, SECOND);
    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByText("Stagg")).toBeTruthy();

    releaseFirst(
      Response.json({ upc: UPC, matches: [EAGLE], candidates: [], externalName: null }),
    );
    expect(await screen.findByText("Eagle Rare 10 Year")).toBeTruthy();
    await screen.findByText(/scanned this session \(2\)/i);
  });

  it("offers external candidates on a DB miss, and confirming teaches the mapping", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    mockFetch((url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.includes("/api/scan/upc"))
        return {
          upc: UPC,
          matches: [],
          candidates: [EAGLE],
          externalName: "Eagle Rare Bourbon 750ml",
        };
      return confirmResponse(EAGLE, "ub-5");
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.type(screen.getByLabelText(/barcode number/i), UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));

    await user.click(await screen.findByRole("button", { name: /needs you/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/eagle rare bourbon 750ml/i);
    await user.click(screen.getByRole("button", { name: /^this one$/i }));

    await screen.findByText(/scanned this session \(1\)/i);
    const confirm = calls.find((c) => c.url.includes("/api/scan/confirm"));
    expect(confirm?.body).toMatchObject({ upc: UPC, bottleId: EAGLE.id });
  });

  it("shows the teach-us sheet with catalog search on a total miss", async () => {
    mockFetch((url) => {
      if (url.includes("/api/scan/upc")) return scanMiss();
      if (url.includes("/api/bottles/search")) return { results: [EAGLE] };
      return confirmResponse(EAGLE, "ub-6");
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.type(screen.getByLabelText(/barcode number/i), UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));

    await user.click(await screen.findByRole("button", { name: /needs you/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/new one on us/i);

    await user.type(screen.getByLabelText(/search the catalog/i), "eagle");
    await user.click(await screen.findByRole("button", { name: /^this one$/i }));
    expect(await screen.findByText(/scanned this session \(1\)/i)).toBeTruthy();
  });

  it("skips a barcode already scanned this session", async () => {
    let scans = 0;
    mockFetch((url) => {
      if (url.includes("/api/scan/upc")) {
        scans += 1;
        return { upc: UPC, matches: [EAGLE], candidates: [], externalName: null };
      }
      return confirmResponse(EAGLE, "ub-7");
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    const input = screen.getByLabelText(/barcode number/i);
    await user.type(input, UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByText(/scanned this session \(1\)/i);

    await user.type(input, UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByText(/already scanned/i)).toBeTruthy();
    expect(scans).toBe(1);
    expect(screen.getByText(/scanned this session \(1\)/i)).toBeTruthy();
  });

  it("undo removes the shelf row and the queue entry", async () => {
    const deletes: string[] = [];
    mockFetch((url, init) => {
      if (url.includes("/api/scan/upc"))
        return { upc: UPC, matches: [EAGLE], candidates: [], externalName: null };
      if (init?.method === "DELETE") {
        deletes.push(url);
        return { ok: true };
      }
      return confirmResponse(EAGLE, "ub-8");
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.type(screen.getByLabelText(/barcode number/i), UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByText(/scanned this session \(1\)/i);

    await user.click(screen.getByRole("button", { name: /undo/i }));
    await waitFor(() => expect(deletes).toContain("/api/user-bottles/ub-8"));
    expect(screen.getByText(/scanned this session \(0\)/i)).toBeTruthy();
  });

  it("confirms a label photo on-device before sending it for analysis", async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url);
      if (url.includes("/api/scan-label"))
        return {
          extracted: { brandGuess: "Eagle Rare", expressionGuess: "10 Year" },
          candidates: [EAGLE],
        };
      return confirmResponse(EAGLE, "ub-9");
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    const file = new File(["fake-image-bytes"], "label.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText(/photograph a bottle label/i), {
      target: { files: [file] },
    });

    // On-device framing confirmation happens BEFORE any network call.
    const confirmDialog = await screen.findByRole("dialog", { name: /confirm label photo/i });
    expect(confirmDialog).toHaveTextContent(/use this photo/i);
    expect(calls.filter((u) => u.includes("/api/scan-label"))).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /use photo/i }));
    await user.click(await screen.findByRole("button", { name: /needs you/i }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveTextContent(/the label reads/i);
    await user.click(screen.getByRole("button", { name: /^this one$/i }));
    expect(await screen.findByText(/scanned this session \(1\)/i)).toBeTruthy();
  });
});

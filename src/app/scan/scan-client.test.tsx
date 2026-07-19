// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): FetchMock {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const result = handler(url, init);
    if (result instanceof Response) return result;
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function scanMiss() {
  return { upc: UPC, matches: [], candidates: [], externalName: null };
}

beforeEach(() => {
  // jsdom has no camera or BarcodeDetector — the component must fall back to
  // manual entry, which is exactly the state we test.
});

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

  it("auto-adds a uniquely matched barcode and shows it in the session tray", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    mockFetch((url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.includes("/api/scan/upc"))
        return { upc: UPC, matches: [EAGLE], candidates: [], externalName: null };
      if (url.includes("/api/scan/confirm"))
        return new Response(
          JSON.stringify({
            mapping: { upc: UPC },
            userBottle: { id: "ub-1" },
            bottle: { id: EAGLE.id, name: EAGLE.name },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
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
      return new Response(
        JSON.stringify({ mapping: null, userBottle: { id: "ub-2" }, bottle: EAGLE }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
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

  it("opens a picker when the barcode is shared across bottlings", async () => {
    mockFetch((url) => {
      if (url.includes("/api/scan/upc"))
        return { upc: UPC, matches: [EAGLE, STAGG], candidates: [], externalName: null };
      return new Response(
        JSON.stringify({ mapping: { upc: UPC }, userBottle: { id: "ub-3" }, bottle: STAGG }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.type(screen.getByLabelText(/barcode number/i), UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/which bottle is this/i);
    expect(dialog).toHaveTextContent("Eagle Rare 10 Year");
    expect(dialog).toHaveTextContent("Stagg");

    const pickButtons = screen.getAllByRole("button", { name: /this one/i });
    await user.click(pickButtons[1]);

    expect(await screen.findByText(/scanned this session \(1\)/i)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
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
      return new Response(
        JSON.stringify({ mapping: { upc: UPC }, userBottle: { id: "ub-4" }, bottle: EAGLE }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.type(screen.getByLabelText(/barcode number/i), UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/eagle rare bourbon 750ml/i);
    await user.click(screen.getByRole("button", { name: /this one/i }));

    await screen.findByText(/scanned this session \(1\)/i);
    const confirm = calls.find((c) => c.url.includes("/api/scan/confirm"));
    expect(confirm?.body).toMatchObject({ upc: UPC, bottleId: EAGLE.id });
  });

  it("shows the teach-us sheet with catalog search on a total miss", async () => {
    mockFetch((url) => {
      if (url.includes("/api/scan/upc")) return scanMiss();
      if (url.includes("/api/bottles/search")) return { results: [EAGLE] };
      return new Response(
        JSON.stringify({ mapping: { upc: UPC }, userBottle: { id: "ub-5" }, bottle: EAGLE }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.type(screen.getByLabelText(/barcode number/i), UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/new one on us/i);

    await user.type(screen.getByLabelText(/search the catalog/i), "eagle");
    await user.click(await screen.findByRole("button", { name: /this one/i }));
    expect(await screen.findByText(/scanned this session \(1\)/i)).toBeTruthy();
  });

  it("skips a barcode already scanned this session", async () => {
    let scans = 0;
    mockFetch((url) => {
      if (url.includes("/api/scan/upc")) {
        scans += 1;
        return { upc: UPC, matches: [EAGLE], candidates: [], externalName: null };
      }
      return new Response(
        JSON.stringify({ mapping: { upc: UPC }, userBottle: { id: "ub-6" }, bottle: EAGLE }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
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

  it("undo removes the shelf row and the tray entry", async () => {
    const deletes: string[] = [];
    mockFetch((url, init) => {
      if (url.includes("/api/scan/upc"))
        return { upc: UPC, matches: [EAGLE], candidates: [], externalName: null };
      if (init?.method === "DELETE") {
        deletes.push(url);
        return { ok: true };
      }
      return new Response(
        JSON.stringify({ mapping: { upc: UPC }, userBottle: { id: "ub-7" }, bottle: EAGLE }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const user = userEvent.setup();
    render(<ScanClient />);

    await user.type(screen.getByLabelText(/barcode number/i), UPC);
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByText(/scanned this session \(1\)/i);

    await user.click(screen.getByRole("button", { name: /undo/i }));
    await waitFor(() => expect(deletes).toContain("/api/user-bottles/ub-7"));
    expect(screen.getByText(/scanned this session \(0\)/i)).toBeTruthy();
  });
});

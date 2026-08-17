// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
import { ShelfDetails, type ShelfDetailsRow } from "./shelf-details";

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.unstubAllGlobals();
});

function row(extra: Partial<ShelfDetailsRow> = {}): ShelfDetailsRow {
  return {
    id: "ub-1",
    status: "open",
    fillLevel: 50,
    purchasePrice: 59.99,
    store: null,
    location: null,
    notes: null,
    ...extra,
  };
}

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ShelfDetails", () => {
  it("patches the fill level and refreshes server-derived data", async () => {
    const fetchMock = stubFetch();
    render(<ShelfDetails row={row()} />);

    fireEvent.click(screen.getByRole("button", { name: "25%" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user-bottles/ub-1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ fillLevel: 25 }) }),
    );
  });

  it("only offers fill steps on an open bottle", () => {
    stubFetch();
    render(<ShelfDetails row={row({ status: "sealed" })} />);
    expect(screen.queryByRole("button", { name: "25%" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark open" })).toBeInTheDocument();
  });

  it("deletes the row and refreshes, so shelf-wide data stops counting it", async () => {
    const fetchMock = stubFetch();
    render(<ShelfDetails row={row()} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/user-bottles/ub-1", { method: "DELETE" });
  });

  it("saves purchase details, blanking cleared fields", async () => {
    const fetchMock = stubFetch();
    render(<ShelfDetails row={row({ store: "K&L" })} />);

    fireEvent.change(screen.getByLabelText(/Paid/), { target: { value: "45.50" } });
    fireEvent.change(screen.getByLabelText("Store"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ purchasePrice: 45.5, store: null, location: null, notes: null });
  });

  it("surfaces a failed update instead of refreshing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<ShelfDetails row={row()} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark finished" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Update failed/));
    expect(refresh).not.toHaveBeenCalled();
  });
});

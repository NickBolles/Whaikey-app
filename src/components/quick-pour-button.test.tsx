// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const router = { refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { QuickPourButton } from "@/components/quick-pour-button";
import { ToastProvider } from "@/components/toast";

function renderButton() {
  return render(<QuickPourButton bottleId="eagle-rare-10" bottleName="Eagle Rare 10 Year" />, {
    wrapper: ToastProvider,
  });
}

function notifications() {
  return within(screen.getByRole("region", { name: "Notifications" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("QuickPourButton", () => {
  it("logs a pour and confirms it with an undoable toast", async () => {
    const fetchMock = vi.fn(async () => Response.json({ pour: { id: "pour-123" } }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Log a pour of Eagle Rare 10 Year" }));

    await waitFor(() => expect(notifications().getByText("Poured Eagle Rare 10 Year")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/pours", expect.objectContaining({ method: "POST" }));
    expect(screen.getByTestId("quick-pour")).toHaveTextContent("Poured ✓");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("Undo deletes exactly the pour it made and resets the button", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? Response.json({ ok: true })
        : Response.json({ pour: { id: "pour-123" } }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Log a pour of Eagle Rare 10 Year" }));
    const undo = await waitFor(() => notifications().getByRole("button", { name: "Undo" }));
    await act(async () => {
      fireEvent.click(undo);
    });

    expect(fetchMock).toHaveBeenLastCalledWith("/api/pours/pour-123", { method: "DELETE" });
    expect(notifications().queryByText("Poured Eagle Rare 10 Year")).not.toBeInTheDocument();
    expect(screen.getByTestId("quick-pour")).toHaveTextContent("Pour");
    expect(screen.getByTestId("quick-pour")).toBeEnabled();
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps the pour and says so when the undo is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "DELETE"
          ? new Response(null, { status: 500 })
          : Response.json({ pour: { id: "pour-123" } }, { status: 201 }),
      ),
    );
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Log a pour of Eagle Rare 10 Year" }));
    const undo = await waitFor(() => notifications().getByRole("button", { name: "Undo" }));
    await act(async () => {
      fireEvent.click(undo);
    });

    expect(notifications().getByText("Couldn't undo that. It's still saved.")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pour")).toHaveTextContent("Poured ✓");
  });

  it("reports a failed pour in the toast region instead of only on the button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Log a pour of Eagle Rare 10 Year" }));

    await waitFor(() =>
      expect(notifications().getByText("Couldn't log a pour of Eagle Rare 10 Year. Try again.")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("quick-pour")).toHaveTextContent("Retry");
  });

  it("offers no undo when the server did not say which pour it made", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 201 })));
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Log a pour of Eagle Rare 10 Year" }));

    await waitFor(() => expect(notifications().getByText("Poured Eagle Rare 10 Year")).toBeInTheDocument());
    expect(notifications().queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });
});

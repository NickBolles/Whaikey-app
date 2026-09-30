// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  ERROR_TOAST_DURATION_MS,
  MAX_VISIBLE_TOASTS,
  TOAST_DURATION_MS,
  ToastProvider,
  useToast,
  type ToastApi,
} from "@/components/toast";

let api: ToastApi;
/** Every value the hook returned, one entry per commit. */
const seen: ToastApi[] = [];
function capture(value: ToastApi) {
  api = value;
  seen.push(value);
}

/** Captures the hook's API (after each commit) so each test can drive it directly. */
function Harness() {
  const toast = useToast();
  useEffect(() => capture(toast));
  return null;
}

function renderToasts() {
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
}

function region() {
  return within(screen.getByRole("region", { name: "Notifications" }));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ToastProvider / useToast", () => {
  it("shows a message in a live region that is always mounted", () => {
    renderToasts();
    const live = screen.getByRole("region", { name: "Notifications" });
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");

    act(() => void api.show("Added Eagle Rare 10 Year"));
    expect(region().getByText("Added Eagle Rare 10 Year")).toBeInTheDocument();
  });

  it("closes itself after four seconds without calling undo", () => {
    renderToasts();
    const undo = vi.fn();
    const onClose = vi.fn();
    act(() => void api.show({ message: "Removed Lagavulin 16", undo, onClose }));

    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 1));
    expect(region().getByText("Removed Lagavulin 16")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(region().queryByText("Removed Lagavulin 16")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("timeout");
    expect(undo).not.toHaveBeenCalled();
  });

  it("fires the inverse action on Undo, then closes with 'undone'", async () => {
    renderToasts();
    // An inverse-action undo: the removal already happened; undo reverses it.
    const shelf = new Set<string>();
    const undo = vi.fn(async () => {
      shelf.add("lagavulin-16");
    });
    const onClose = vi.fn();
    act(() => void api.show({ message: "Removed Lagavulin 16", undo, onClose }));

    await act(async () => {
      fireEvent.click(region().getByRole("button", { name: "Undo" }));
    });

    expect(undo).toHaveBeenCalledTimes(1);
    expect(shelf.has("lagavulin-16")).toBe(true);
    expect(region().queryByText("Removed Lagavulin 16")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("undone");
  });

  it("holds the toast while an async undo is in flight, and does not time it out", async () => {
    renderToasts();
    let finish!: () => void;
    const undo = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    act(() => void api.show({ message: "Pour deleted", undo }));

    fireEvent.click(region().getByRole("button", { name: "Undo" }));
    const pending = region().getByRole("button", { name: "Undoing…" });
    expect(pending).toBeDisabled();

    // Far past the timeout: an undo in flight is not the clock's to cancel.
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS * 3));
    expect(region().getByText("Pour deleted")).toBeInTheDocument();
    // And a second tap does not run it twice.
    fireEvent.click(pending);
    expect(undo).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    expect(region().queryByText("Pour deleted")).not.toBeInTheDocument();
  });

  it("reports an undo that fails, and tells the caller the mutation stands", async () => {
    renderToasts();
    const onClose = vi.fn();
    act(
      () =>
        void api.show({
          message: "Made private",
          undo: () => Promise.reject(new Error("503")),
          onClose,
        }),
    );

    await act(async () => {
      fireEvent.click(region().getByRole("button", { name: "Undo" }));
    });

    expect(onClose).toHaveBeenCalledExactlyOnceWith("undo-failed");
    expect(region().queryByText("Made private")).not.toBeInTheDocument();
    const error = region().getByText("Couldn't undo that. It's still saved.");
    expect(error.closest("li")).toHaveAttribute("data-toast-tone", "error");
  });

  it("pauses the clock while the pointer is on it, and resumes where it left off", () => {
    renderToasts();
    const onClose = vi.fn();
    act(() => void api.show({ message: "Added to wishlist", undo: vi.fn(), onClose }));
    const toast = region().getByText("Added to wishlist").closest("li")!;

    act(() => vi.advanceTimersByTime(3_000));
    fireEvent.pointerEnter(toast);
    act(() => vi.advanceTimersByTime(10_000));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerLeave(toast);
    act(() => vi.advanceTimersByTime(999));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("pauses while keyboard focus is inside it", () => {
    renderToasts();
    const onClose = vi.fn();
    act(() => void api.show({ message: "Link revoked", undo: vi.fn(), onClose }));

    fireEvent.focus(region().getByRole("button", { name: "Undo" }));
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS * 2));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes with 'dismissed' from the × button and from Escape", () => {
    renderToasts();
    const first = vi.fn();
    const second = vi.fn();
    act(() => void api.show({ message: "One", onClose: first }));
    act(() => void api.show({ message: "Two", onClose: second }));

    fireEvent.click(within(region().getByText("One").closest("li")!).getByRole("button", { name: "Dismiss notification" }));
    expect(first).toHaveBeenCalledExactlyOnceWith("dismissed");

    fireEvent.keyDown(region().getByText("Two"), { key: "Escape" });
    expect(second).toHaveBeenCalledExactlyOnceWith("dismissed");
    expect(region().queryAllByRole("listitem")).toHaveLength(0);
  });

  it("dismiss(id) closes a toast from code", () => {
    renderToasts();
    const onClose = vi.fn();
    let id = "";
    act(() => {
      id = api.show({ message: "Saving…", onClose });
    });
    act(() => api.dismiss(id));
    expect(region().queryByText("Saving…")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("dismissed");
    // Idempotent: a second dismiss is a no-op, not a second onClose.
    act(() => api.dismiss(id));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it(`keeps at most ${MAX_VISIBLE_TOASTS}, closing the oldest with 'replaced'`, () => {
    renderToasts();
    const oldest = vi.fn();
    act(() => void api.show({ message: "Toast 1", onClose: oldest }));
    for (let i = 2; i <= MAX_VISIBLE_TOASTS + 1; i++) {
      act(() => void api.show(`Toast ${i}`));
    }
    expect(region().getAllByRole("listitem")).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(region().queryByText("Toast 1")).not.toBeInTheDocument();
    expect(oldest).toHaveBeenCalledExactlyOnceWith("replaced");
  });

  it("runs an action and closes the toast", () => {
    renderToasts();
    const onClick = vi.fn();
    act(() => void api.show({ message: "Pour saved", action: { label: "View", onClick } }));
    fireEvent.click(region().getByRole("button", { name: "View" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(region().queryByText("Pour saved")).not.toBeInTheDocument();
  });

  it("error() stays longer and offers no undo", () => {
    renderToasts();
    act(() => void api.error("Couldn't save that. Try again."));
    const toast = region().getByText("Couldn't save that. Try again.").closest("li")!;
    expect(toast).toHaveAttribute("data-toast-tone", "error");
    expect(within(toast).queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS));
    expect(region().getByText("Couldn't save that. Try again.")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(ERROR_TOAST_DURATION_MS - TOAST_DURATION_MS));
    expect(region().queryByText("Couldn't save that. Try again.")).not.toBeInTheDocument();
  });

  it("returns the same API object across renders, so it is safe in effect deps", () => {
    const tree = (
      <ToastProvider>
        <Harness />
      </ToastProvider>
    );
    const { rerender } = render(tree);
    const first = api;
    seen.length = 0;
    // Toasts change the provider's state; a parent re-render re-runs Harness.
    act(() => void api.show("Re-render the provider"));
    rerender(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) expect(value).toBe(first);
  });

  it("throws a clear error when used without a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Harness />)).toThrow(/needs a <ToastProvider>/);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const router = { push: vi.fn(), refresh: vi.fn(), back: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { HomeConcierge } from "@/components/home-concierge";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HomeConcierge", () => {
  it("routes a typed question to /chat with the q param", async () => {
    render(<HomeConcierge aiConfigured />);

    await userEvent.type(
      screen.getByLabelText("Ask about your bar", { selector: "input" }),
      "What pairs with steak?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask concierge" }));

    expect(router.push).toHaveBeenCalledWith(
      `/chat?q=${encodeURIComponent("What pairs with steak?")}`,
    );
  });

  it("keeps submit disabled for empty or whitespace-only input", async () => {
    render(<HomeConcierge aiConfigured />);

    const submit = screen.getByRole("button", { name: "Ask concierge" });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Ask about your bar", { selector: "input" }), "   ");
    expect(submit).toBeDisabled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("shows the quiet unconfigured note without an input when AI is not set up", () => {
    render(<HomeConcierge aiConfigured={false} />);

    expect(screen.getByText(/isn’t configured on this server yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Ask about your bar", { selector: "input" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask concierge" })).not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewOutingForm } from "./new-outing-form";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

function mockApi(status: number) {
  const calls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ path: "/o/abc123def4" }), { status });
    }),
  );
  return calls;
}

describe("NewOutingForm", () => {
  it("names the outing after the distillery unless given a name, and opens it", async () => {
    const user = userEvent.setup();
    const calls = mockApi(201);
    render(<NewOutingForm clubs={[{ id: "c1", name: "Tuesday Drams" }]} defaultClubId="c1" today="2026-10-31" />);
    expect((screen.getByRole("button", { name: "Create the outing" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Distillery"), "Buffalo Trace");
    await user.type(screen.getByLabelText("Where (optional)"), "Frankfort, KY");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Create the outing" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/o/abc123def4"));
    expect(calls[0]).toEqual({
      title: "Day at Buffalo Trace",
      distilleryName: "Buffalo Trace",
      visitOn: "2026-10-31",
      rideReminder: false,
      location: "Frankfort, KY",
      clubId: "c1",
    });
  });

  it("explains a missing profile and other failures", async () => {
    const user = userEvent.setup();
    mockApi(409);
    render(<NewOutingForm clubs={[]} defaultClubId="" today="2026-10-31" />);
    await user.type(screen.getByLabelText("Distillery"), "Ardbeg");
    await user.type(screen.getByLabelText("Name (optional)"), "Islay day");
    await user.click(screen.getByRole("button", { name: "Create the outing" }));
    expect(await screen.findByText(/Set up your profile/)).toBeTruthy();
    cleanup();
    mockApi(400);
    render(<NewOutingForm clubs={[]} defaultClubId="" today="2026-10-31" />);
    await user.type(screen.getByLabelText("Distillery"), "Ardbeg");
    await user.click(screen.getByRole("button", { name: "Create the outing" }));
    expect(await screen.findByText(/Couldn't create the outing/)).toBeTruthy();
  });
});

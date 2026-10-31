// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

import { ReactionChips, Replies } from "./outing-social";
import { OutingInsightsPanel, OutingRecognitions } from "./outing-insights";
import { OUTING_REACTIONS, type OutingCommentView, type OutingReactionView } from "@/lib/outings/social";
import type { OutingInsights } from "@/lib/outings/insights";

let status = 200;
const fetchMock = vi.fn(async () => new Response("{}", { status }));
beforeEach(() => {
  status = 200;
  refresh.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const agree: OutingReactionView = { kind: "agree", label: "Agree", glyph: "=", count: 2, who: ["@ana", "You"], mine: true };
const comment = (over: Partial<OutingCommentView> = {}): OutingCommentView => ({
  id: "c1",
  who: "@ben",
  mine: false,
  body: "Same pear here @ana",
  edited: false,
  mentions: ["@ana"],
  mentionsMe: true,
  createdAt: new Date("2026-10-29T19:00:00Z"),
  ...over,
});

describe("ReactionChips", () => {
  it("shows counts and who reacted, opens all eight chips, and toggles your own off", async () => {
    render(<ReactionChips code="abc" targetKind="bottle" targetId="b:1" reactions={[agree]} canReact />);
    const chip = screen.getByRole("button", { name: /Agree.*2 people.*@ana, You/ });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.contextMenu(chip);
    expect(screen.getByText("Agree: @ana, You")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "React" }));
    const group = screen.getByRole("group", { name: "Reactions" });
    expect(group.querySelectorAll("button[aria-pressed]")).toHaveLength(OUTING_REACTIONS.length);
    expect(OUTING_REACTIONS).toHaveLength(8);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Agree/ })));
    expect(fetchMock).toHaveBeenCalledWith("/api/outings/abc/reactions", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ targetKind: "bottle", targetId: "b:1", kind: "agree", on: false });
    expect(refresh).toHaveBeenCalled();
  });

  it("releasing a long press shows who without toggling the reaction", async () => {
    vi.useFakeTimers();
    render(<ReactionChips code="abc" targetKind="bottle" targetId="b:1" reactions={[agree]} canReact />);
    const chip = screen.getByRole("button", { name: /Agree.*2 people/ });
    fireEvent.pointerDown(chip);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    fireEvent.pointerUp(chip);
    fireEvent.click(chip);
    expect(screen.getByText("Agree: @ana, You")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("long-press reveals who; read-only viewers can't react; nothing renders when empty", () => {
    vi.useFakeTimers();
    const { unmount } = render(<ReactionChips code="abc" targetKind="tasting" targetId="t1" reactions={[{ ...agree, mine: false }]} canReact={false} compact />);
    const chip = screen.getByRole("button", { name: /Agree/ });
    expect(chip).toBeDisabled();
    expect(screen.queryByRole("button", { name: "React" })).toBeNull();
    fireEvent.pointerDown(chip);
    act(() => void vi.advanceTimersByTime(500));
    expect(screen.getByText("Agree: @ana, You")).toBeInTheDocument();
    fireEvent.pointerUp(chip);
    unmount();
    const { container } = render(<ReactionChips code="abc" targetKind="tasting" targetId="t1" reactions={[]} canReact={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Replies", () => {
  it("posts a reply, highlights mentions, edits your own and the host hides others'", async () => {
    const { rerender } = render(<Replies code="abc" targetKind="tasting" targetId="t1" comments={[comment()]} canReply isHost={false} about="Ana's rating" />);
    expect(screen.getByText("mentioned you")).toBeInTheDocument();
    expect(screen.getByText("@ana")).toHaveClass("text-accent");
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reply on Ana's rating" }));
    fireEvent.change(screen.getByLabelText("Reply on Ana's rating"), { target: { value: "Honey too" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Post reply" })));
    expect(fetchMock).toHaveBeenCalledWith("/api/outings/abc/comments", expect.objectContaining({ method: "POST" }));
    expect(refresh).toHaveBeenCalled();

    rerender(<Replies code="abc" targetKind="tasting" targetId="t1" comments={[comment({ mine: true, who: "You", edited: true })]} canReply isHost={false} about="Ana's rating" />);
    expect(screen.getByText("(edited)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit your reply"), { target: { value: "Edited" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/outings/abc/comments/c1", expect.objectContaining({ method: "PATCH" }));

    rerender(<Replies code="abc" targetKind="tasting" targetId="t1" comments={[comment()]} canReply={false} isHost about="Ana's rating" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Hide" })));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/outings/abc/comments/c1", expect.objectContaining({ method: "DELETE" }));
  });

  it("explains the cap, offline and failed removals; cancel clears the draft", async () => {
    render(<Replies code="abc" targetKind="bottle" targetId="b:1" comments={[comment({ mine: true })]} canReply isHost={false} about="Lagavulin 16" />);
    fireEvent.click(screen.getByRole("button", { name: "Reply on Lagavulin 16" }));
    const box = screen.getByLabelText("Reply on Lagavulin 16");
    fireEvent.change(box, { target: { value: "One more" } });
    status = 429;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Post reply" })));
    expect(screen.getByRole("alert")).toHaveTextContent("reply limit");
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Post reply" })));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No signal"));
    status = 500;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Post reply" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't post that reply.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't remove that reply.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

const empty: OutingInsights = { waiting: null, twins: null, closest: null, learnFrom: null, favourite: null, divisive: null, agreed: [], calledIt: null };

describe("OutingInsightsPanel / OutingRecognitions", () => {
  it("says plainly what it is waiting for", () => {
    render(<OutingInsightsPanel insights={{ ...empty, waiting: "Insights need at least 2 of the same bottles rated by 2 people." }} />);
    expect(screen.getByText(/at least 2 of the same bottles/)).toBeInTheDocument();
  });

  it("renders every insight once there's enough, with no counts of pours", () => {
    const sim = { a: "p1", b: "p2", shared: 3, gap: 0.3 } as never;
    render(
      <OutingInsightsPanel
        insights={{
          ...empty,
          closest: { ...(sim as object), name: "@ana", why: "Within half a star on 3 bottles." } as never,
          twins: { ...(sim as object), aName: "@ana", bName: "@ben", why: "Agreed on 3." } as never,
          learnFrom: { participantId: "p1", name: "@ana", why: "Her notes got Learned something twice." },
          favourite: { key: "b:1", label: "Lagavulin 16", average: 4.5, raters: 3 },
          divisive: { key: "b:2", label: "Ardbeg 10", low: 2, high: 5, why: "From 2 to 5 stars." },
          calledIt: { participantId: "p2", name: "@ben", label: "Lagavulin 16", why: "Rated it first, the group agreed." },
          agreed: [{ key: "b:1", label: "Lagavulin 16", tags: ["smoke", "pear"] }],
        }}
      />,
    );
    for (const t of ["Your closest palate", "Palate twins", "Learn from @ana", "Group favourite so far", "Most divisive", "Called it", "Notes the group agreed on"]) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getByText("4.5 stars from 3 people.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/pour|ml|oz|streak/i);
  });

  it("hints how to unlock your closest palate, and renders nothing without data", () => {
    const { container, rerender } = render(<OutingInsightsPanel insights={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<OutingInsightsPanel insights={{ ...empty, favourite: { key: "b:1", label: "Lagavulin 16", average: 4, raters: 2 } }} />);
    expect(screen.getByText(/Rate two of the same bottles/)).toBeInTheDocument();
    rerender(<OutingRecognitions items={[]} />);
    expect(screen.queryByText("Recognitions")).toBeNull();
    rerender(<OutingRecognitions items={[{ id: "sharpest_nose", title: "Sharpest nose", who: "@ana", why: "Her descriptors matched the group most." }]} />);
    expect(screen.getByText("Sharpest nose")).toBeInTheDocument();
  });
});

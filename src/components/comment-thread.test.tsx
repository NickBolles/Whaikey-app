// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommentThread, type SerializedComment } from "@/components/comment-thread";
import type { ProfileSummary } from "@/lib/social";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetchOnce(response: { ok: boolean; status: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const alice: ProfileSummary = { userId: "u-alice", handle: "alice", displayName: "Alice", avatarUrl: null };
const bob: ProfileSummary = { userId: "u-bob", handle: "bob", displayName: "Bob", avatarUrl: null };

function makeComment(overrides: Partial<SerializedComment> = {}): SerializedComment {
  return {
    id: "c1",
    pourId: "p1",
    parentId: null,
    author: alice,
    body: "Great pour!",
    createdAt: new Date().toISOString(),
    editedAt: null,
    deleted: false,
    canEdit: false,
    canDelete: false,
    ...overrides,
  };
}

describe("CommentThread", () => {
  it("renders top-level comments with their replies nested underneath", () => {
    const top = makeComment({ id: "c1", body: "Great pour!" });
    const reply = makeComment({ id: "c2", parentId: "c1", author: bob, body: "Totally agree." });
    render(
      <CommentThread pourId="p1" initialComments={[top, reply]} viewerSignedIn viewerCanComment isOwner={false} viewerUserId="u-viewer" />,
    );

    expect(screen.getByText("Great pour!")).toBeInTheDocument();
    expect(screen.getByText("Totally agree.")).toBeInTheDocument();
  });

  it("shows a tombstone for a deleted comment while its reply keeps rendering", () => {
    const top = makeComment({ id: "c1", deleted: true, body: null, author: null });
    const reply = makeComment({ id: "c2", parentId: "c1", author: bob, body: "Still here." });
    render(
      <CommentThread pourId="p1" initialComments={[top, reply]} viewerSignedIn viewerCanComment isOwner={false} />,
    );

    expect(screen.getByText("Comment removed")).toBeInTheDocument();
    expect(screen.getByText("Still here.")).toBeInTheDocument();
  });

  it("shows an edited marker on edited comments", () => {
    const top = makeComment({ editedAt: new Date().toISOString() });
    render(<CommentThread pourId="p1" initialComments={[top]} viewerSignedIn viewerCanComment isOwner={false} />);

    expect(screen.getByText(/edited/i)).toBeInTheDocument();
  });

  it("posts a new top-level comment from the composer", async () => {
    const created = makeComment({ id: "c-new", body: "New note" });
    const fetchMock = mockFetchOnce({ ok: true, status: 201, body: created });
    render(<CommentThread pourId="p1" initialComments={[]} viewerSignedIn viewerCanComment isOwner={false} />);

    await userEvent.type(screen.getByPlaceholderText("Add a comment…"), "New note");
    await userEvent.click(screen.getByRole("button", { name: /post/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/comments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ pourId: "p1", body: "New note" }),
      }),
    );
    expect(await screen.findByText("New note")).toBeInTheDocument();
  });

  it("keeps a post-pour draft and renders its local note reference as a link", async () => {
    const created = makeComment({ id: "c-linked", body: "I just logged my take too: /notes/my-pour" });
    const fetchMock = mockFetchOnce({ ok: true, status: 201, body: created });
    render(
      <CommentThread
        pourId="p1"
        initialComments={[]}
        viewerSignedIn
        viewerCanComment
        isOwner={false}
        initialDraft="I just logged my take too: /notes/my-pour"
      />,
    );

    expect(screen.getByDisplayValue("I just logged my take too: /notes/my-pour")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /post/i }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/comments",
      expect.objectContaining({ body: JSON.stringify({ pourId: "p1", body: "I just logged my take too: /notes/my-pour" }) }),
    );
    expect((await screen.findByRole("link", { name: "View linked pour" })).getAttribute("href")).toBe("/notes/my-pour");
  });

  it("sets parentId when replying to a top-level comment", async () => {
    const top = makeComment({ id: "c1" });
    const created = makeComment({ id: "c-reply", parentId: "c1", body: "A reply" });
    const fetchMock = mockFetchOnce({ ok: true, status: 201, body: created });
    render(<CommentThread pourId="p1" initialComments={[top]} viewerSignedIn viewerCanComment isOwner={false} />);

    await userEvent.click(screen.getByRole("button", { name: /reply/i }));
    const replyTextarea = screen.getByPlaceholderText("Reply…");
    await userEvent.type(replyTextarea, "A reply");
    const replyForm = replyTextarea.closest("form")!;
    await userEvent.click(within(replyForm).getByRole("button", { name: /post/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/comments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ pourId: "p1", body: "A reply", parentId: "c1" }),
      }),
    );
    expect(await screen.findByText("A reply")).toBeInTheDocument();
  });

  it("shows Edit only when canEdit is true", () => {
    const editable = makeComment({ id: "c1", canEdit: true });
    render(<CommentThread pourId="p1" initialComments={[editable]} viewerSignedIn viewerCanComment isOwner={false} />);
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
  });

  it("hides Edit when canEdit is false", () => {
    const notEditable = makeComment({ id: "c1", canEdit: false });
    render(<CommentThread pourId="p1" initialComments={[notEditable]} viewerSignedIn viewerCanComment isOwner={false} />);
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  it("edits a comment inline via PATCH", async () => {
    const editable = makeComment({ id: "c1", canEdit: true, body: "Original" });
    const updated = makeComment({ id: "c1", canEdit: true, body: "Updated", editedAt: new Date().toISOString() });
    const fetchMock = mockFetchOnce({ ok: true, status: 200, body: updated });
    render(<CommentThread pourId="p1" initialComments={[editable]} viewerSignedIn viewerCanComment isOwner={false} />);

    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    const textarea = screen.getByDisplayValue("Original");
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "Updated");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/comments/c1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ body: "Updated" }) }),
    );
    expect(await screen.findByText("Updated")).toBeInTheDocument();
    expect(screen.getByText(/edited/i)).toBeInTheDocument();
  });

  it("deletes a comment through an inline confirm and shows a tombstone", async () => {
    const deletable = makeComment({ id: "c1", canDelete: true });
    const fetchMock = mockFetchOnce({ ok: true, status: 200, body: { deleted: true } });
    render(<CommentThread pourId="p1" initialComments={[deletable]} viewerSignedIn viewerCanComment isOwner={false} />);

    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(screen.getByText(/delete this comment/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(fetchMock).toHaveBeenCalledWith("/api/social/comments/c1", { method: "DELETE" });
    expect(await screen.findByText("Comment removed")).toBeInTheDocument();
  });

  it("runs the report flow to completion", async () => {
    const other = makeComment({ id: "c1", author: bob });
    const fetchMock = mockFetchOnce({ ok: true, status: 201, body: { ok: true } });
    render(
      <CommentThread pourId="p1" initialComments={[other]} viewerSignedIn viewerCanComment isOwner={false} viewerUserId="u-viewer" />,
    );

    await userEvent.click(screen.getByRole("button", { name: /report/i }));
    expect(screen.getByLabelText(/report reason/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/social/reports",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ subjectType: "comment", subjectId: "c1", reason: "spam" }),
      }),
    );
    expect(await screen.findByText("Reported")).toBeInTheDocument();
  });

  it("hides Report on the viewer's own comment", () => {
    const mine = makeComment({ id: "c1", author: alice });
    render(
      <CommentThread pourId="p1" initialComments={[mine]} viewerSignedIn viewerCanComment isOwner={false} viewerUserId={alice.userId} />,
    );
    expect(screen.queryByRole("button", { name: /report/i })).not.toBeInTheDocument();
  });

  it("shows a comments-off state and hides the composer", () => {
    render(<CommentThread pourId="p1" initialComments={[]} viewerSignedIn viewerCanComment={false} isOwner={false} />);
    expect(screen.getByText(/comments are off for this note/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Add a comment…")).not.toBeInTheDocument();
  });

  it("prompts sign-in instead of a composer for a signed-out viewer", () => {
    render(<CommentThread pourId="p1" initialComments={[]} viewerSignedIn={false} viewerCanComment isOwner={false} />);
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute("href", "/sign-in");
    expect(screen.queryByPlaceholderText("Add a comment…")).not.toBeInTheDocument();
  });

  it("disables posting and flags the count over the character cap", () => {
    render(<CommentThread pourId="p1" initialComments={[]} viewerSignedIn viewerCanComment isOwner={false} />);
    const textarea = screen.getByPlaceholderText("Add a comment…");
    fireEvent.change(textarea, { target: { value: "a".repeat(1001) } });

    expect(screen.getByText("1001/1000")).toHaveClass("text-danger");
    expect(screen.getByRole("button", { name: /post/i })).toBeDisabled();
  });

  it("shows a claim-handle hint on 409 profile_required from the composer", async () => {
    mockFetchOnce({ ok: false, status: 409, body: { error: "profile_required" } });
    render(<CommentThread pourId="p1" initialComments={[]} viewerSignedIn viewerCanComment isOwner={false} />);

    await userEvent.type(screen.getByPlaceholderText("Add a comment…"), "Hello");
    await userEvent.click(screen.getByRole("button", { name: /post/i }));

    const hint = await screen.findByText(/claim a handle to join in/i);
    expect(within(hint.closest("p")!).getByRole("link")).toHaveAttribute("href", "/friends");
  });
});

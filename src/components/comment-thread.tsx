"use client";

import { useState } from "react";
import Link from "next/link";
import { CornerDownRight, Flag, MessageCircle, Pencil, Send, Trash2 } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import type { ProfileSummary } from "@/lib/social";

// Mirrors COMMENT_MAX_LENGTH in src/lib/social.ts, duplicated deliberately —
// that module pulls in server-only db code and can't be imported into a
// client bundle (same pattern as src/components/profile-claim.tsx's HANDLE_RE).
const COMMENT_MAX_LENGTH = 1000;

const REPORT_REASONS: Array<{ value: string; label: string }> = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment" },
  { value: "impersonation", label: "Impersonation" },
  { value: "other", label: "Other" },
];

export interface SerializedComment {
  id: string;
  pourId: string;
  parentId: string | null;
  author: ProfileSummary | null;
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

interface ComposerProps {
  placeholder: string;
  busy: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}

function Composer({ placeholder, busy, onSubmit, onCancel, autoFocus }: ComposerProps) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const overLimit = value.length > COMMENT_MAX_LENGTH;
  const canSubmit = trimmed.length > 0 && !overLimit && !busy;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    await onSubmit(trimmed);
    setValue("");
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        rows={2}
        autoFocus={autoFocus}
        maxLength={COMMENT_MAX_LENGTH + 200}
        className="min-h-[44px] resize-none rounded-xl border border-border-subtle bg-surface px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      />
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs ${overLimit ? "text-danger" : "text-muted"}`}>
          {value.length}/{COMMENT_MAX_LENGTH}
        </span>
        <div className="flex items-center gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="tap-target rounded-xl px-3 text-xs text-muted transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={!canSubmit}
            className="btn-primary tap-target inline-flex items-center gap-1.5 px-4 text-sm disabled:opacity-60"
          >
            <Send size={14} strokeWidth={1.8} aria-hidden /> {busy ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
    </form>
  );
}

function ClaimHandleHint() {
  return (
    <p className="text-xs text-muted">
      <Link href="/friends" className="text-accent transition-[filter] hover:brightness-110">
        Claim a handle to join in
      </Link>
    </p>
  );
}

interface CommentRowProps {
  comment: SerializedComment;
  isReply: boolean;
  viewerSignedIn: boolean;
  viewerCanComment: boolean;
  viewerUserId: string | null;
  busyId: string | null;
  replyOpenId: string | null;
  editingId: string | null;
  deletingId: string | null;
  reportingId: string | null;
  reportedIds: Set<string>;
  errorId: string | null;
  onReplyToggle: (id: string) => void;
  onReplySubmit: (parentId: string, body: string) => Promise<void>;
  onEditToggle: (id: string) => void;
  onEditSubmit: (id: string, body: string) => Promise<void>;
  onDeleteToggle: (id: string) => void;
  onDeleteConfirm: (id: string) => Promise<void>;
  onReportToggle: (id: string) => void;
  onReportSubmit: (id: string, reason: string) => Promise<void>;
}

function CommentRow(props: CommentRowProps) {
  const {
    comment,
    isReply,
    viewerSignedIn,
    viewerCanComment,
    viewerUserId,
    busyId,
    replyOpenId,
    editingId,
    deletingId,
    reportingId,
    reportedIds,
    errorId,
    onReplyToggle,
    onReplySubmit,
    onEditToggle,
    onEditSubmit,
    onDeleteToggle,
    onDeleteConfirm,
    onReportToggle,
    onReportSubmit,
  } = props;

  const [reportReason, setReportReason] = useState(REPORT_REASONS[0].value);
  const busy = busyId === comment.id;
  const isAuthor = viewerUserId != null && comment.author?.userId === viewerUserId;
  const canReport = !comment.deleted && viewerSignedIn && comment.author != null && !isAuthor;
  const reported = reportedIds.has(comment.id);

  if (comment.deleted) {
    return (
      <li className={isReply ? "ml-8 border-l border-border-subtle pl-3" : ""}>
        <p className="text-sm italic text-muted">Comment removed</p>
      </li>
    );
  }

  return (
    <li className={isReply ? "ml-8 border-l border-border-subtle pl-3" : "flex flex-col gap-2"}>
      <div className="flex items-start gap-2.5">
        <UserAvatar name={comment.author?.displayName || comment.author?.handle || "?"} image={comment.author?.avatarUrl} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {comment.author ? (
              <Link href={`/u/${comment.author.handle}`} className="text-sm font-medium hover:text-accent transition-colors">
                {comment.author.displayName || `@${comment.author.handle}`}
              </Link>
            ) : (
              <span className="text-sm font-medium text-muted">Someone</span>
            )}
            <span className="text-xs text-muted">{formatRelativeTime(comment.createdAt)}</span>
            {comment.editedAt && <span className="text-xs text-muted">· edited</span>}
          </div>

          {editingId === comment.id ? (
            <div className="mt-1.5">
              <EditComposer
                initialBody={comment.body ?? ""}
                busy={busy}
                onSubmit={(body) => onEditSubmit(comment.id, body)}
                onCancel={() => onEditToggle(comment.id)}
              />
            </div>
          ) : (
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground/90">{comment.body}</p>
          )}

          {editingId !== comment.id && (
            <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted">
              {!isReply && viewerSignedIn && viewerCanComment && (
                <button type="button" onClick={() => onReplyToggle(comment.id)} className="tap-target inline-flex items-center gap-1 transition-colors hover:text-foreground">
                  <CornerDownRight size={13} strokeWidth={1.8} aria-hidden /> Reply
                </button>
              )}
              {comment.canEdit && (
                <button type="button" onClick={() => onEditToggle(comment.id)} className="tap-target inline-flex items-center gap-1 transition-colors hover:text-foreground">
                  <Pencil size={13} strokeWidth={1.8} aria-hidden /> Edit
                </button>
              )}
              {comment.canDelete &&
                (deletingId === comment.id ? (
                  <span className="inline-flex items-center gap-2">
                    Delete this comment?
                    <button type="button" onClick={() => onDeleteConfirm(comment.id)} disabled={busy} className="font-medium text-danger">
                      {busy ? "…" : "Confirm"}
                    </button>
                    <button type="button" onClick={() => onDeleteToggle(comment.id)} className="text-muted">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button type="button" onClick={() => onDeleteToggle(comment.id)} className="tap-target inline-flex items-center gap-1 transition-colors hover:text-danger">
                    <Trash2 size={13} strokeWidth={1.8} aria-hidden /> Delete
                  </button>
                ))}
              {canReport &&
                (reported ? (
                  <span className="text-muted">Reported</span>
                ) : reportingId === comment.id ? (
                  <span className="inline-flex items-center gap-1.5">
                    <select
                      value={reportReason}
                      onChange={(event) => setReportReason(event.target.value)}
                      aria-label="Report reason"
                      className="rounded-lg border border-border-subtle bg-surface px-1.5 py-1 text-xs"
                    >
                      {REPORT_REASONS.map((reason) => (
                        <option key={reason.value} value={reason.value}>
                          {reason.label}
                        </option>
                      ))}
                    </select>
                    <button type="button" onClick={() => onReportSubmit(comment.id, reportReason)} disabled={busy} className="font-medium text-accent">
                      {busy ? "…" : "Send"}
                    </button>
                    <button type="button" onClick={() => onReportToggle(comment.id)} className="text-muted">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button type="button" onClick={() => onReportToggle(comment.id)} className="tap-target inline-flex items-center gap-1 transition-colors hover:text-foreground">
                    <Flag size={13} strokeWidth={1.8} aria-hidden /> Report
                  </button>
                ))}
            </div>
          )}
          {errorId === comment.id && (
            <p role="alert" className="mt-1 text-xs text-danger">
              Couldn&apos;t do that — try again.
            </p>
          )}
        </div>
      </div>

      {!isReply && replyOpenId === comment.id && (
        <div className="ml-8 border-l border-border-subtle pl-3">
          <Composer placeholder="Reply…" busy={busy} onSubmit={(body) => onReplySubmit(comment.id, body)} onCancel={() => onReplyToggle(comment.id)} autoFocus />
        </div>
      )}
    </li>
  );
}

function EditComposer({
  initialBody,
  busy,
  onSubmit,
  onCancel,
}: {
  initialBody: string;
  busy: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialBody);
  const trimmed = value.trim();
  const overLimit = value.length > COMMENT_MAX_LENGTH;
  const canSubmit = trimmed.length > 0 && !overLimit && !busy;

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={2}
        maxLength={COMMENT_MAX_LENGTH + 200}
        className="min-h-[44px] resize-none rounded-xl border border-border-subtle bg-surface px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      />
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs ${overLimit ? "text-danger" : "text-muted"}`}>
          {value.length}/{COMMENT_MAX_LENGTH}
        </span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} className="tap-target rounded-xl px-3 text-xs text-muted transition-colors hover:text-foreground">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => canSubmit && onSubmit(trimmed)}
            disabled={!canSubmit}
            className="btn-primary tap-target px-4 text-sm disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface CommentThreadProps {
  pourId: string;
  initialComments: SerializedComment[];
  viewerSignedIn: boolean;
  /** Whether the note's owner currently allows new comments. */
  viewerCanComment: boolean;
  isOwner: boolean;
  /** Used only to hide the Report action on the viewer's own comments. */
  viewerUserId?: string | null;
}

/**
 * Threaded comments on a note (docs/SOCIAL.md US-12, §7.5): one level of
 * replies, plain text (React escaping — never dangerouslySetInnerHTML), edit
 * window, soft delete leaves a tombstone while replies keep rendering.
 */
export function CommentThread({ pourId, initialComments, viewerSignedIn, viewerCanComment, isOwner, viewerUserId = null }: CommentThreadProps) {
  const [comments, setComments] = useState<SerializedComment[]>(initialComments);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replyOpenId, setReplyOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [reportedIds, setReportedIds] = useState<Set<string>>(new Set());
  const [errorId, setErrorId] = useState<string | null>(null);
  const [composerHint, setComposerHint] = useState<"profile_required" | "error" | null>(null);
  const [rootBusy, setRootBusy] = useState(false);

  const topLevel = comments.filter((c) => !c.parentId);
  const repliesFor = (id: string) => comments.filter((c) => c.parentId === id);

  async function postComment(body: string, parentId?: string): Promise<boolean> {
    setComposerHint(null);
    if (parentId) setBusyId(parentId);
    else setRootBusy(true);
    try {
      const res = await fetch("/api/social/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pourId, body, ...(parentId ? { parentId } : {}) }),
      });
      if (res.status === 409) {
        setComposerHint("profile_required");
        return false;
      }
      if (!res.ok) throw new Error("Couldn't post that comment.");
      const created = (await res.json()) as SerializedComment;
      setComments((prev) => [...prev, created]);
      return true;
    } catch {
      setComposerHint("error");
      return false;
    } finally {
      if (parentId) setBusyId(null);
      else setRootBusy(false);
    }
  }

  async function handleRootSubmit(body: string) {
    await postComment(body);
  }

  async function handleReplySubmit(parentId: string, body: string) {
    const ok = await postComment(body, parentId);
    if (ok) setReplyOpenId(null);
  }

  async function handleEditSubmit(id: string, body: string) {
    setBusyId(id);
    setErrorId(null);
    try {
      const res = await fetch(`/api/social/comments/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error("Couldn't save that edit.");
      const updated = (await res.json()) as SerializedComment;
      setComments((prev) => prev.map((c) => (c.id === id ? updated : c)));
      setEditingId(null);
    } catch {
      setErrorId(id);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteConfirm(id: string) {
    setBusyId(id);
    setErrorId(null);
    try {
      const res = await fetch(`/api/social/comments/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Couldn't delete that.");
      setComments((prev) => prev.map((c) => (c.id === id ? { ...c, deleted: true, body: null, author: null, canEdit: false, canDelete: false } : c)));
      setDeletingId(null);
    } catch {
      setErrorId(id);
    } finally {
      setBusyId(null);
    }
  }

  async function handleReportSubmit(id: string, reason: string) {
    setBusyId(id);
    setErrorId(null);
    try {
      const res = await fetch("/api/social/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectType: "comment", subjectId: id, reason }),
      });
      if (res.status === 409) {
        setComposerHint("profile_required");
        return;
      }
      if (!res.ok) throw new Error("Couldn't send that report.");
      setReportedIds((prev) => new Set(prev).add(id));
      setReportingId(null);
    } catch {
      setErrorId(id);
    } finally {
      setBusyId(null);
    }
  }

  const rowProps = {
    viewerSignedIn,
    viewerCanComment,
    viewerUserId,
    busyId,
    replyOpenId,
    editingId,
    deletingId,
    reportingId,
    reportedIds,
    errorId,
    onReplyToggle: (id: string) => setReplyOpenId((cur) => (cur === id ? null : id)),
    onReplySubmit: handleReplySubmit,
    onEditToggle: (id: string) => setEditingId((cur) => (cur === id ? null : id)),
    onEditSubmit: handleEditSubmit,
    onDeleteToggle: (id: string) => setDeletingId((cur) => (cur === id ? null : id)),
    onDeleteConfirm: handleDeleteConfirm,
    onReportToggle: (id: string) => setReportingId((cur) => (cur === id ? null : id)),
    onReportSubmit: handleReportSubmit,
  };

  return (
    <section className="card flex flex-col gap-5 p-5">
      <div className="flex items-center gap-2">
        <MessageCircle size={18} strokeWidth={1.8} className="text-muted" aria-hidden />
        <h2 className="font-display text-lg font-semibold">Comments</h2>
        {isOwner && <span className="chip px-2.5 py-0.5 text-[11px]">You moderate this thread</span>}
      </div>

      {topLevel.length === 0 ? (
        <p className="text-sm text-muted">No comments yet — start the conversation.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {topLevel.map((comment) => (
            <div key={comment.id} className="flex flex-col gap-2">
              <CommentRow comment={comment} isReply={false} {...rowProps} />
              {repliesFor(comment.id).length > 0 && (
                <ul className="flex flex-col gap-3">
                  {repliesFor(comment.id).map((reply) => (
                    <CommentRow key={reply.id} comment={reply} isReply {...rowProps} />
                  ))}
                </ul>
              )}
            </div>
          ))}
        </ul>
      )}

      {!viewerCanComment ? (
        <p className="text-sm text-muted">Comments are off for this note.</p>
      ) : !viewerSignedIn ? (
        <p className="text-sm text-muted">
          <Link href="/sign-in" className="text-accent transition-[filter] hover:brightness-110">
            Sign in
          </Link>{" "}
          to join the discussion.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-4">
          <Composer placeholder="Add a comment…" busy={rootBusy} onSubmit={handleRootSubmit} />
          {composerHint === "profile_required" && <ClaimHandleHint />}
          {composerHint === "error" && (
            <p role="alert" className="text-xs text-danger">
              Couldn&apos;t post that comment.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

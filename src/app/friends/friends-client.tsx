"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AtSign, Check, ShieldOff, UserMinus, UserPlus, UserX, X } from "lucide-react";
import { ProfileSummaryRow } from "@/components/profile-summary-row";
import { FriendQr } from "@/components/friend-qr";
import { QrScanButton } from "@/components/qr-scan-button";
import type { FollowState } from "@/db/schema";
import type { ProfileSummary } from "@/lib/social";
import { DiscoverySettings } from "./discovery-settings";

type FollowingRow = ProfileSummary & { state: FollowState; mutual: boolean };

type PeopleTab = "following" | "followers" | "blocked";

export interface FriendsClientProps {
  /** The signed-in user's own handle, for the Find friends card's QR code. */
  handle: string;
  phoneLast2: string | null;
  phoneDiscoverable: boolean;
  requests: ProfileSummary[];
  following: FollowingRow[];
  followers: ProfileSummary[];
  blocked: ProfileSummary[];
}

/**
 * US-5/US-10: the /friends body — requests first, then the Find friends card
 * (the page's one accent moment), then the people lists behind a segmented
 * control, with discovery settings demoted to a disclosure at the bottom.
 */
export function FriendsClient({
  handle,
  phoneLast2,
  phoneDiscoverable,
  requests,
  following,
  followers,
  blocked,
}: FriendsClientProps) {
  const [requestRows, setRequestRows] = useState(requests);
  const [followingRows, setFollowingRows] = useState(following);
  const [followerRows, setFollowerRows] = useState(followers);
  const [blockedRows, setBlockedRows] = useState(blocked);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [peopleTab, setPeopleTab] = useState<PeopleTab>("following");

  // Server refreshes (router.refresh() after a follow) re-send props; the
  // optimistic row state must follow them or the page shows stale lists.
  const [syncedProps, setSyncedProps] = useState({ requests, following, followers, blocked });
  if (
    syncedProps.requests !== requests ||
    syncedProps.following !== following ||
    syncedProps.followers !== followers ||
    syncedProps.blocked !== blocked
  ) {
    setSyncedProps({ requests, following, followers, blocked });
    setRequestRows(requests);
    setFollowingRows(following);
    setFollowerRows(followers);
    setBlockedRows(blocked);
  }

  async function run(userId: string, action: () => Promise<boolean>) {
    if (busyId) return;
    setBusyId(userId);
    setSectionError(null);
    try {
      const ok = await action();
      if (!ok) setSectionError("That didn't go through — try again.");
    } catch {
      setSectionError("That didn't go through — try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function approve(row: ProfileSummary) {
    await run(row.userId, async () => {
      const res = await fetch(`/api/social/follows/${row.userId}/approve`, { method: "POST" });
      if (!res.ok) return false;
      setRequestRows((rows) => rows.filter((r) => r.userId !== row.userId));
      setFollowerRows((rows) => [row, ...rows]);
      return true;
    });
  }

  async function deny(userId: string) {
    await run(userId, async () => {
      const res = await fetch(`/api/social/follows/${userId}/request`, { method: "DELETE" });
      if (!res.ok) return false;
      setRequestRows((rows) => rows.filter((r) => r.userId !== userId));
      return true;
    });
  }

  async function unfollow(userId: string) {
    await run(userId, async () => {
      const res = await fetch(`/api/social/follows/${userId}`, { method: "DELETE" });
      if (!res.ok) return false;
      setFollowingRows((rows) => rows.filter((r) => r.userId !== userId));
      return true;
    });
  }

  async function removeFollower(userId: string) {
    await run(userId, async () => {
      const res = await fetch(`/api/social/follows/${userId}/follower`, { method: "DELETE" });
      if (!res.ok) return false;
      setFollowerRows((rows) => rows.filter((r) => r.userId !== userId));
      return true;
    });
  }

  async function unblock(userId: string) {
    await run(userId, async () => {
      const res = await fetch(`/api/social/blocks/${userId}`, { method: "DELETE" });
      if (!res.ok) return false;
      // The Blocked tab vanishes with its last row — move the selection to
      // Following explicitly so a later prop resync (someone newly blocked
      // elsewhere) doesn't snap the panel back to Blocked unprompted. Reading
      // the render-time rows is safe: busyId serializes these actions.
      if (blockedRows.filter((r) => r.userId !== userId).length === 0) setPeopleTab("following");
      setBlockedRows((rows) => rows.filter((r) => r.userId !== userId));
      return true;
    });
  }

  // The Blocked tab exists only while there's someone to show — when the last
  // unblock empties it the control falls back to Following rather than
  // pointing at a vanished tab.
  const showBlockedTab = blockedRows.length > 0;
  const activeTab: PeopleTab = peopleTab === "blocked" && !showBlockedTab ? "following" : peopleTab;

  const tabs: Array<{ key: PeopleTab; label: string; count: number }> = [
    { key: "following", label: "Following", count: followingRows.length },
    { key: "followers", label: "Followers", count: followerRows.length },
    ...(showBlockedTab ? [{ key: "blocked" as const, label: "Blocked", count: blockedRows.length }] : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      {requestRows.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="section-label">Requests ({requestRows.length})</h2>
          <ul className="flex flex-col gap-2">
            {requestRows.map((row) => (
              <ProfileSummaryRow
                key={row.userId}
                profile={row}
                right={
                  <>
                    <button
                      type="button"
                      onClick={() => approve(row)}
                      disabled={busyId === row.userId}
                      aria-label={`Approve ${row.handle}`}
                      className="tap-target flex h-9 w-9 items-center justify-center rounded-xl border border-border-subtle text-accent transition-colors hover:border-accent/60 disabled:opacity-60"
                    >
                      <Check size={16} strokeWidth={1.8} aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => deny(row.userId)}
                      disabled={busyId === row.userId}
                      aria-label={`Deny ${row.handle}`}
                      className="tap-target flex h-9 w-9 items-center justify-center rounded-xl border border-border-subtle text-muted transition-colors hover:border-danger/60 hover:text-danger disabled:opacity-60"
                    >
                      <X size={16} strokeWidth={1.8} aria-hidden />
                    </button>
                  </>
                }
              />
            ))}
          </ul>
        </section>
      )}

      <FindFriendsCard handle={handle} />

      {sectionError && (
        <p role="alert" className="text-sm text-danger">
          {sectionError}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="section-label">People</h2>
        <div
          role="tablist"
          aria-label="People"
          className="inline-flex self-start rounded-full border border-border-subtle bg-background p-1 gap-0.5"
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              id={`people-tab-${tab.key}`}
              aria-selected={activeTab === tab.key}
              aria-controls="people-panel"
              onClick={() => setPeopleTab(tab.key)}
              className={`tap-target inline-flex min-h-10 items-center rounded-full px-3.5 text-[13px] font-medium transition-colors ${
                activeTab === tab.key ? "chip-active" : "text-muted hover:text-foreground"
              }`}
            >
              {tab.label}
              <span className="ml-1.5 text-[10.5px] opacity-60 tabular-nums">{tab.count}</span>
            </button>
          ))}
        </div>

        <div role="tabpanel" id="people-panel" aria-labelledby={`people-tab-${activeTab}`}>
          {activeTab === "following" &&
            (followingRows.length === 0 ? (
              <p className="text-sm text-muted">Not following anyone yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {followingRows.map((row) => (
                  <ProfileSummaryRow
                    key={row.userId}
                    profile={row}
                    subtitle={
                      row.mutual ? (
                        <span className="chip chip-active px-2 py-0.5 text-[10px]">Friends</span>
                      ) : row.state === "pending" ? (
                        <span className="text-[10px] text-muted">Requested</span>
                      ) : null
                    }
                    right={
                      <button
                        type="button"
                        onClick={() => unfollow(row.userId)}
                        disabled={busyId === row.userId}
                        className="tap-target inline-flex items-center gap-1.5 rounded-xl border border-border-subtle px-3 py-2 text-xs text-muted transition-colors hover:border-danger/60 hover:text-danger disabled:opacity-60"
                      >
                        <UserMinus size={14} strokeWidth={1.8} aria-hidden />{" "}
                        {row.state === "pending" ? "Cancel" : "Unfollow"}
                      </button>
                    }
                  />
                ))}
              </ul>
            ))}

          {activeTab === "followers" &&
            (followerRows.length === 0 ? (
              <p className="text-sm text-muted">No followers yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {followerRows.map((row) => (
                  <ProfileSummaryRow
                    key={row.userId}
                    profile={row}
                    right={
                      <button
                        type="button"
                        onClick={() => removeFollower(row.userId)}
                        disabled={busyId === row.userId}
                        className="tap-target inline-flex items-center gap-1.5 rounded-xl border border-border-subtle px-3 py-2 text-xs text-muted transition-colors hover:border-danger/60 hover:text-danger disabled:opacity-60"
                      >
                        <UserX size={14} strokeWidth={1.8} aria-hidden /> Remove
                      </button>
                    }
                  />
                ))}
              </ul>
            ))}

          {activeTab === "blocked" && (
            <ul className="flex flex-col gap-2">
              {blockedRows.map((row) => (
                <ProfileSummaryRow
                  key={row.userId}
                  profile={row}
                  right={
                    <button
                      type="button"
                      onClick={() => unblock(row.userId)}
                      disabled={busyId === row.userId}
                      className="tap-target inline-flex items-center gap-1.5 rounded-xl border border-border-subtle px-3 py-2 text-xs text-muted transition-colors hover:border-accent/60 hover:text-foreground disabled:opacity-60"
                    >
                      <ShieldOff size={14} strokeWidth={1.8} aria-hidden /> Unblock
                    </button>
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      <DiscoverySettings initialPhoneLast2={phoneLast2} initialPhoneDiscoverable={phoneDiscoverable} />
    </div>
  );
}

/**
 * A phone-shaped input. An explicit "@" prefix is always a handle (handles may
 * be digits-only, e.g. @1234567, and must stay reachable); otherwise phone
 * means a leading "+" or 7+ characters drawn purely from phone punctuation —
 * anything containing a letter or underscore is a handle.
 */
function looksLikePhone(input: string): boolean {
  if (input.startsWith("@")) return false;
  if (input.startsWith("+")) return true;
  return /^[\d\s().-]{7,}$/.test(input);
}

/**
 * The page's one accent moment: a single input for @handle or phone number
 * with the primary Add button, plus the QR show/scan pair beneath. Both text
 * paths land on /add/[handle] — nothing follows on lookup alone
 * (docs/SOCIAL.md §7.2).
 */
function FindFriendsCard({ handle }: { handle: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setStatus(null);
    setIsError(false);
    try {
      if (looksLikePhone(trimmed)) {
        const res = await fetch("/api/social/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone: trimmed }),
        });
        if (res.status === 429) {
          setStatus("Too many lookups — try again in a bit.");
          setIsError(true);
          return;
        }
        if (res.status === 400) {
          setStatus("That doesn't look like a phone number.");
          setIsError(true);
          return;
        }
        const body = (await res.json().catch(() => null)) as { profile?: ProfileSummary | null } | null;
        if (!res.ok || !body) {
          setStatus("Couldn't look that up — try again.");
          setIsError(true);
          return;
        }
        if (!body.profile) {
          setStatus("No one found by that number. They may not have opted in — ask them for their @handle or code.");
          setIsError(true);
          return;
        }
        setValue("");
        router.push(`/add/${body.profile.handle}`);
        return;
      }

      const normalized = trimmed.replace(/^@/, "").toLowerCase();
      setValue("");
      router.push(`/add/${normalized}`);
    } catch {
      setStatus("Couldn't send that — try again.");
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card flex flex-col gap-3 p-5">
      <h2 className="section-label">Find friends</h2>
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <div className="flex min-h-11 flex-1 items-center gap-1.5 rounded-xl border border-border-subtle bg-surface px-3 focus-within:ring-2 focus-within:ring-accent/60">
          <AtSign size={16} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={32}
            placeholder="@handle or phone number"
            aria-label="Handle or phone number to add"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="btn-primary tap-target inline-flex min-h-11 items-center gap-1.5 px-4 text-sm disabled:opacity-60"
        >
          <UserPlus size={16} strokeWidth={1.8} aria-hidden /> {busy ? "…" : "Add"}
        </button>
      </form>
      {status && (
        <p role="status" className={`text-xs ${isError ? "text-danger" : "text-muted"}`}>
          {status}
        </p>
      )}
      <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-3">
        <FriendQr handle={handle} />
        <QrScanButton />
      </div>
    </section>
  );
}

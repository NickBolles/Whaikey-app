"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { share } from "@/lib/native/share";
import { BRAND_NAME } from "@/lib/brand";

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

/** Create a club (name + optional description). */
export function CreateClubForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await send("/api/clubs", "POST", { name }).catch(() => null);
    setBusy(false);
    if (res?.status === 201) {
      const { id } = (await res.json()) as { id: string };
      router.push(`/clubs/${id}`);
    } else if (res?.status === 409) setError("Set up your profile on the People tab first.");
    else setError("Couldn't create the club — check the name and try again.");
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor="club-name" className="text-sm">
        Start a club
      </label>
      <div className="flex gap-2">
        <input
          id="club-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="Tuesday Drams"
          className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm"
        />
        <button type="submit" disabled={busy || name.trim().length < 2} className="btn-primary px-4 text-sm disabled:opacity-60">
          Create
        </button>
      </div>
      {error && (
        <p role="status" className="text-xs text-muted">
          {error}
        </p>
      )}
    </form>
  );
}

/** Owner/admin: mint an invite link, show it as a QR, share it natively. */
export function ClubInvite({ clubId, clubName }: { clubId: string; clubName: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!link) return;
    void QRCode.toDataURL(link, { margin: 1, width: 220 }).then(setQr, () => setQr(null));
  }, [link]);
  async function mint() {
    setError(false);
    const res = await send(`/api/clubs/${clubId}/invites`, "POST").catch(() => null);
    if (res?.status !== 201) return setError(true);
    const { path } = (await res.json()) as { path: string };
    setLink(`${window.location.origin}${path}`);
  }
  return (
    <div className="flex flex-col gap-2">
      {!link ? (
        <button type="button" onClick={() => void mint()} className="btn-secondary w-fit px-4 py-2 text-sm">
          Invite people
        </button>
      ) : (
        <div className="flex items-center gap-3">
          {qr && <img src={qr} alt={`QR code to join ${clubName}`} width={110} height={110} className="rounded-lg bg-white p-1" />}
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="break-all text-xs text-muted">{link}</p>
            <button
              type="button"
              onClick={() => void share({ title: `Join ${clubName} on ${BRAND_NAME}`, text: `Join ${clubName} on ${BRAND_NAME}`, url: link })}
              className="btn-secondary w-fit px-3 py-1.5 text-sm"
            >
              Share link
            </button>
            <p className="text-[11px] text-muted">Works for 7 days. Only people with the link can join.</p>
          </div>
        </div>
      )}
      {error && (
        <p role="status" className="text-xs text-muted">
          Couldn&rsquo;t make an invite — try again.
        </p>
      )}
    </div>
  );
}

/** Leave (self) or remove (admin) a member, with a confirm. */
export function MemberRemove({ clubId, userId, label, self }: { clubId: string; userId: string; label: string; self: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function go() {
    if (busy || !window.confirm(self ? "Leave this club?" : `Remove ${label} from the club?`)) return;
    setBusy(true);
    const res = await send(`/api/clubs/${clubId}/members/${self ? "me" : userId}`, "DELETE").catch(() => null);
    setBusy(false);
    if (res?.ok) {
      if (self) router.push("/clubs");
      else router.refresh();
    }
  }
  return (
    <button type="button" onClick={() => void go()} disabled={busy} className="text-xs text-muted hover:text-foreground disabled:opacity-60">
      {self ? "Leave club" : "Remove"}
    </button>
  );
}

/** Accept an invite. */
export function JoinClubButton({ code }: { code: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    const res = await send("/api/clubs/join", "POST", { code }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      const { clubId } = (await res.json()) as { clubId: string };
      router.push(`/clubs/${clubId}`);
    } else if (res?.status === 409) setError("Set up your profile on the People tab first, then come back to this link.");
    else setError("This invite has expired or was withdrawn. Ask for a new one.");
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <button type="button" onClick={() => void go()} disabled={busy} className="btn-primary px-8 py-3 disabled:opacity-60">
        {busy ? "Joining…" : "Join the club"}
      </button>
      {error && (
        <p role="status" className="text-sm text-muted">
          {error}
        </p>
      )}
    </div>
  );
}

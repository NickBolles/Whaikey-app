"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ChevronDown, Phone, Trash2 } from "lucide-react";
import { ToggleSwitch } from "@/components/toggle-switch";

interface PhoneSaveResponse {
  phoneLast2?: string;
  phoneDiscoverable?: boolean;
  error?: string;
}

/**
 * "Discovery settings" — the demoted, collapsed-by-default home for the
 * phone-discovery plumbing (docs/SOCIAL.md §7.2, D8 as amended): save/replace/
 * remove a number plus the never-pre-selected "find me by phone" opt-in.
 * The QR show/scan pair lives in the Find friends card, not here — this
 * disclosure is settings, not an action surface.
 */
export function DiscoverySettings({
  initialPhoneLast2,
  initialPhoneDiscoverable,
}: {
  initialPhoneLast2: string | null;
  initialPhoneDiscoverable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [phoneLast2, setPhoneLast2] = useState(initialPhoneLast2);
  const [discoverable, setDiscoverable] = useState(initialPhoneDiscoverable);
  const [phoneInput, setPhoneInput] = useState("");
  // Discovery is a separate, explicit opt-in (docs/SOCIAL.md D8 as amended):
  // saving a number must never preselect exposure.
  const [newDiscoverable, setNewDiscoverable] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function savePhone(event: FormEvent) {
    event.preventDefault();
    if (busy || !phoneInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/phone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: phoneInput.trim(), discoverable: newDiscoverable }),
      });
      const body = (await res.json().catch(() => null)) as PhoneSaveResponse | null;
      if (res.status === 400) {
        setError("That doesn't look like a phone number.");
        return;
      }
      if (res.status === 409) {
        setError(
          body?.error === "phone_taken"
            ? "That number's already linked to another account."
            : body?.error === "social_disabled"
              ? "Turn social back on first, from your profile."
              : "Couldn't save that number.",
        );
        return;
      }
      if (res.status === 429) {
        setError("Too many attempts — try again in an hour.");
        return;
      }
      if (!res.ok || !body?.phoneLast2) {
        setError("Couldn't save that number — try again.");
        return;
      }
      setPhoneLast2(body.phoneLast2);
      setDiscoverable(Boolean(body.phoneDiscoverable));
      setPhoneInput("");
      setNewDiscoverable(false);
      setEditing(false);
    } catch {
      setError("Couldn't save that number — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removePhone() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/phone", { method: "DELETE" });
      if (!res.ok) throw new Error("remove failed");
      setPhoneLast2(null);
      setDiscoverable(false);
      // The add form is about to reappear — a leftover true here would let a
      // replacement number post discoverable without a fresh opt-in.
      setNewDiscoverable(false);
    } catch {
      setError("Couldn't remove that number — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleDiscoverable(next: boolean) {
    // One write at a time, reconciled from the server's acknowledgement —
    // overlapping toggles could otherwise commit out of order and leave the
    // switch showing OFF while the database says discoverable.
    if (busy) return;
    const previous = discoverable;
    setBusy(true);
    setDiscoverable(next);
    setError(null);
    try {
      const res = await fetch("/api/social/phone", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ discoverable: next }),
      });
      if (!res.ok) throw new Error("update failed");
      const saved = (await res.json().catch(() => null)) as { phoneDiscoverable?: boolean } | null;
      if (typeof saved?.phoneDiscoverable === "boolean") setDiscoverable(saved.phoneDiscoverable);
    } catch {
      setDiscoverable(previous);
      setError("Couldn't update that — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="discovery-settings-panel"
        className="tap-target flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl p-5 text-left"
      >
        <span className="flex flex-col gap-0.5">
          <span className="section-label">Discovery settings</span>
          <span className="text-xs text-muted">How friends find you</span>
        </span>
        <ChevronDown
          size={18}
          strokeWidth={1.8}
          aria-hidden
          className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div id="discovery-settings-panel" className="flex flex-col gap-4 border-t border-border-subtle p-5 pt-4">
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Phone size={16} strokeWidth={1.8} className="text-muted" aria-hidden /> Phone number
            </p>
            <p className="text-xs leading-relaxed text-muted">
              Only people who already know your number can find you with it. It&apos;s stored scrambled and
              never shown to anyone.
            </p>

            {phoneLast2 && !editing ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted">
                  •••• ••{phoneLast2} · {discoverable ? "discoverable" : "not discoverable"}
                </p>
                <ToggleSwitch
                  label="Let people find me by phone"
                  checked={discoverable}
                  onChange={(next) => void toggleDiscoverable(next)}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      // Replacing re-opens the add form: discovery starts off
                      // again, whatever the previous save opted into.
                      setNewDiscoverable(false);
                      setEditing(true);
                    }}
                    className="btn-secondary tap-target px-3 py-2 text-xs"
                  >
                    Replace number
                  </button>
                  <button
                    type="button"
                    onClick={() => void removePhone()}
                    disabled={busy}
                    className="tap-target inline-flex items-center gap-1.5 rounded-xl border border-border-subtle px-3 py-2 text-xs text-muted transition-colors hover:border-danger/60 hover:text-danger disabled:opacity-60"
                  >
                    <Trash2 size={14} strokeWidth={1.8} aria-hidden /> Remove
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={savePhone} className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <input
                    value={phoneInput}
                    onChange={(event) => setPhoneInput(event.target.value)}
                    inputMode="tel"
                    placeholder="+1 555 123 4567"
                    aria-label="Phone number"
                    className="min-h-11 flex-1 rounded-xl border border-border-subtle bg-surface px-3 text-sm outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
                  />
                  <button
                    type="submit"
                    disabled={busy || !phoneInput.trim()}
                    className="btn-secondary tap-target px-4 text-sm disabled:opacity-60"
                  >
                    {busy ? "Saving…" : "Save"}
                  </button>
                </div>
                <ToggleSwitch
                  label="Let people find me by phone"
                  checked={newDiscoverable}
                  onChange={setNewDiscoverable}
                />
                {editing && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setPhoneInput("");
                      setError(null);
                    }}
                    className="self-start text-xs text-muted hover:text-foreground"
                  >
                    Cancel
                  </button>
                )}
              </form>
            )}

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </div>

          <Link
            href="/sharing"
            className="self-start text-sm text-muted transition-colors hover:text-foreground"
          >
            Privacy &amp; sharing →
          </Link>
        </div>
      )}
    </section>
  );
}

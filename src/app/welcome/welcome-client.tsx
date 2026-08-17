"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AtSign,
  Check,
  ChevronLeft,
  GlassWater,
  Heart,
  Phone,
  ScanLine,
  Search as SearchIcon,
  UserPlus,
  Users,
} from "lucide-react";
import type { FollowState } from "@/db/schema";
import type { AddTarget, ProfileSummary } from "@/lib/social";
import type { BottleSearchResult } from "@/lib/search";
import { categoryLabel } from "@/components/category-chip";
import { FriendQr } from "@/components/friend-qr";
import { ToggleSwitch } from "@/components/toggle-switch";
import { UserAvatar } from "@/components/user-avatar";

// Kept in sync by hand with src/lib/onboarding.ts (ONBOARDING_COOKIE) and
// src/lib/social.ts (HANDLE_RE) — neither is imported at runtime here because
// both pull in server-only db code (the profile-claim.tsx idiom).
const ONBOARDING_COOKIE = "whaikey_onboarded";
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** Finish/skip marker: Home stops redirecting here once this is set. */
function setOnboardedCookie() {
  document.cookie = `${ONBOARDING_COOKIE}=1; path=/; max-age=31536000`;
}

/**
 * A phone-shaped input — copied from src/app/friends/friends-client.tsx. An
 * explicit "@" prefix is always a handle (handles may be digits-only);
 * otherwise phone means a leading "+" or 7+ characters drawn purely from
 * phone punctuation.
 */
function looksLikePhone(input: string): boolean {
  if (input.startsWith("@")) return false;
  if (input.startsWith("+")) return true;
  return /^[\d\s().-]{7,}$/.test(input);
}

interface OwnProfile {
  handle: string;
  displayName: string;
}

export interface WelcomeClientProps {
  accountName: string;
  suggestedHandle: string;
  initialProfile: OwnProfile | null;
  initialPhoneLast2: string | null;
  initialPhoneDiscoverable: boolean;
}

const TOTAL_STEPS = 4;

/**
 * The first-run wizard (docs/SOCIAL.md §7.1 as amended 2026-08): every step
 * is skippable, nothing is opted in by default, and failures never block
 * progression. All mutations are fetch() to existing API routes.
 */
export function WelcomeClient({
  accountName,
  suggestedHandle,
  initialProfile,
  initialPhoneLast2,
  initialPhoneDiscoverable,
}: WelcomeClientProps) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [profile, setProfile] = useState<OwnProfile | null>(initialProfile);

  function goHome() {
    setOnboardedCookie();
    router.push("/");
    router.refresh();
  }

  function next() {
    if (step >= TOTAL_STEPS - 1) {
      setOnboardedCookie();
      setDone(true);
    } else {
      setStep(step + 1);
    }
  }

  /** A quiet skip: marks onboarding done (skipping is a valid finish) and moves on. */
  function skipStep() {
    setOnboardedCookie();
    next();
  }

  if (done) {
    return (
      <div className="mx-auto flex min-h-[85dvh] max-w-lg flex-col items-center justify-center gap-6 px-4 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🥃
        </div>
        <div>
          <h1 className="font-display text-3xl font-semibold">You&apos;re set.</h1>
          <p className="mt-2 max-w-xs text-muted">
            Your bar, your palate, your pours — everything from here is yours to explore.
          </p>
        </div>
        <button type="button" onClick={goHome} className="btn-primary px-8 py-3">
          Open Whaikey
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[85dvh] max-w-lg flex-col px-4 pb-24 pt-5">
      <header className="flex min-h-11 items-center justify-between gap-3">
        {step > 0 ? (
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            aria-label="Back"
            className="tap-target flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:text-foreground"
          >
            <ChevronLeft size={18} strokeWidth={1.8} aria-hidden />
          </button>
        ) : (
          <span className="h-9 w-9" aria-hidden />
        )}

        <div className="flex items-center gap-2" role="img" aria-label={`Step ${step + 1} of ${TOTAL_STEPS}`}>
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <span
              key={i}
              aria-hidden
              className={`h-1.5 rounded-full transition-colors ${
                i === step ? "w-5 bg-accent" : "w-1.5 bg-muted/40"
              }`}
            />
          ))}
        </div>

        {step > 0 ? (
          <button
            type="button"
            onClick={skipStep}
            className="tap-target px-1 text-sm text-muted transition-colors hover:text-foreground"
          >
            Skip
          </button>
        ) : (
          <span className="h-9 w-9" aria-hidden />
        )}
      </header>

      <div className="mt-6 flex flex-1 flex-col">
        {step === 0 && <StepWelcome onStart={next} onSkipTour={goHome} />}
        {step === 1 && (
          <StepProfile
            accountName={accountName}
            suggestedHandle={suggestedHandle}
            profile={profile}
            onClaimed={(p) => {
              setProfile(p);
              next();
            }}
            onContinue={next}
          />
        )}
        {step === 2 && (
          <StepFriends
            profile={profile}
            initialPhoneLast2={initialPhoneLast2}
            initialPhoneDiscoverable={initialPhoneDiscoverable}
            onBackToProfile={() => setStep(1)}
            onContinue={next}
            onSkip={skipStep}
          />
        )}
        {step === 3 && <StepBottle onFinish={next} onLeaveForScan={setOnboardedCookie} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Welcome
// ---------------------------------------------------------------------------

function StepWelcome({ onStart, onSkipTour }: { onStart: () => void; onSkipTour: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-9 text-center">
      <div>
        <div aria-hidden className="mb-4 text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🥃
        </div>
        <h1 className="font-display text-4xl font-semibold tracking-tight text-gradient-amber">Whaikey</h1>
      </div>

      <ul className="flex flex-col gap-4 text-left">
        <ValueLine icon={<GlassWater size={18} strokeWidth={1.8} aria-hidden />} text="Track your bottles" />
        <ValueLine icon={<Heart size={18} strokeWidth={1.8} aria-hidden />} text="Map your palate" />
        <ValueLine icon={<Users size={18} strokeWidth={1.8} aria-hidden />} text="Compare notes with friends" />
      </ul>

      <div className="flex w-full max-w-xs flex-col items-center gap-4">
        <button type="button" onClick={onStart} className="btn-primary w-full py-3.5">
          Set me up
        </button>
        <button
          type="button"
          onClick={onSkipTour}
          className="tap-target text-sm text-muted transition-colors hover:text-foreground"
        >
          Skip the tour
        </button>
      </div>
    </div>
  );
}

function ValueLine({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <li className="flex items-center gap-3">
      <span className="text-muted">{icon}</span>
      <span className="font-display text-lg">{text}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Your profile
// ---------------------------------------------------------------------------

function StepProfile({
  accountName,
  suggestedHandle,
  profile,
  onClaimed,
  onContinue,
}: {
  accountName: string;
  suggestedHandle: string;
  profile: OwnProfile | null;
  onClaimed: (profile: OwnProfile) => void;
  onContinue: () => void;
}) {
  const [displayName, setDisplayName] = useState(accountName);
  const [handle, setHandle] = useState(suggestedHandle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = handle.toLowerCase();
  const isValid = HANDLE_RE.test(normalized);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || !isValid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/social/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handle: normalized,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { handle?: string; displayName?: string; error?: string }
        | null;
      if (res.status === 409 && body?.error === "profile_exists") {
        // Claimed elsewhere (another tab, /friends) — recover the real handle
        // and continue rather than dead-ending.
        const own = await fetch("/api/social/profile").then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const existing = (own as { profile?: OwnProfile | null } | null)?.profile;
        if (existing?.handle) {
          onClaimed({ handle: existing.handle, displayName: existing.displayName ?? "" });
          return;
        }
        setError("Couldn't claim that handle — try again.");
        return;
      }
      if (res.status === 409) {
        setError("That handle's already taken — try another.");
        return;
      }
      if (res.status === 400) {
        setError("Handles are 3–20 characters: lowercase letters, numbers, underscores.");
        return;
      }
      if (!res.ok || !body?.handle) throw new Error("Couldn't claim that handle.");
      onClaimed({ handle: body.handle, displayName: body.displayName ?? displayName.trim() });
    } catch {
      setError("Couldn't claim that handle — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (profile) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeading
          label="Step 2"
          title="Your profile"
          lede="Friends find you by handle. Yours is already claimed."
        />
        <div className="card-flat flex items-center gap-2 p-4 text-sm text-muted">
          <Check size={18} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden />
          You&apos;re @{profile.handle}.
        </div>
        <button type="button" onClick={onContinue} className="btn-primary w-full py-3.5">
          Continue
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <StepHeading
        label="Step 2"
        title="Your profile"
        lede="A name friends recognize, and a handle they can find. Both stay private-by-default — a profile shares nothing on its own."
      />

      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">Display name</span>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={80}
          placeholder="Your name"
          aria-label="Display name"
          className="min-h-11 rounded-xl border border-border-subtle bg-surface px-3 text-sm outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">Handle</span>
        <div className="flex min-h-11 items-center gap-1.5 rounded-xl border border-border-subtle bg-surface px-3 focus-within:ring-2 focus-within:ring-accent/60">
          <AtSign size={16} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
          <input
            value={handle}
            onChange={(event) => setHandle(event.target.value.toLowerCase())}
            maxLength={20}
            placeholder="yourhandle"
            aria-label="Handle"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </div>
        <span className="text-xs text-muted">3–20 characters: lowercase letters, numbers, underscores.</span>
      </label>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy || !isValid} className="btn-primary w-full py-3.5 disabled:opacity-60">
        {busy ? "Claiming…" : "Claim my handle"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Find your friends
// ---------------------------------------------------------------------------

interface FollowedRow {
  profile: ProfileSummary;
  state: FollowState;
}

function StepFriends({
  profile,
  initialPhoneLast2,
  initialPhoneDiscoverable,
  onBackToProfile,
  onContinue,
  onSkip,
}: {
  profile: OwnProfile | null;
  initialPhoneLast2: string | null;
  initialPhoneDiscoverable: boolean;
  onBackToProfile: () => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  if (!profile) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeading
          label="Step 3"
          title="Find your friends"
          lede="Following people needs a handle, and you skipped that part — no problem."
        />
        <div className="card flex flex-col items-center gap-3 p-6 text-center">
          <Users size={20} strokeWidth={1.8} className="text-muted" aria-hidden />
          <p className="font-display text-lg font-semibold">Friends come after a handle</p>
          <p className="text-sm leading-relaxed text-muted">
            Claim one on the previous step, or any time from the Friends page — nothing social happens
            until you do.
          </p>
          <button type="button" onClick={onBackToProfile} className="btn-secondary px-5 py-2.5 text-sm">
            Claim a handle
          </button>
        </div>
        <button type="button" onClick={onSkip} className="btn-primary w-full py-3.5">
          Skip for now
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        label="Step 3"
        title="Find your friends"
        lede="Whiskey's better compared. Everything here is optional and off by default."
      />

      <FriendLookup ownHandle={profile.handle} />

      <PhoneDiscoveryCard
        initialPhoneLast2={initialPhoneLast2}
        initialPhoneDiscoverable={initialPhoneDiscoverable}
      />

      <section className="flex flex-col gap-2">
        <p className="section-label">In person</p>
        <FriendQr handle={profile.handle} />
      </section>

      <button type="button" onClick={onContinue} className="btn-primary w-full py-3.5">
        Continue
      </button>
    </div>
  );
}

/**
 * Optional phone discovery (docs/SOCIAL.md §7.2, D8 as amended): saving a
 * number never preselects exposure — "Let people find me by phone" starts
 * OFF and is a separate, explicit choice.
 */
function PhoneDiscoveryCard({
  initialPhoneLast2,
  initialPhoneDiscoverable,
}: {
  initialPhoneLast2: string | null;
  initialPhoneDiscoverable: boolean;
}) {
  const [phoneLast2, setPhoneLast2] = useState(initialPhoneLast2);
  const [discoverableState, setDiscoverableState] = useState(initialPhoneDiscoverable);
  const [phoneInput, setPhoneInput] = useState("");
  const [newDiscoverable, setNewDiscoverable] = useState(false);
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
      const body = (await res.json().catch(() => null)) as
        | { phoneLast2?: string; phoneDiscoverable?: boolean; error?: string }
        | null;
      if (res.status === 400) {
        setError("That doesn't look like a phone number.");
        return;
      }
      if (res.status === 409) {
        setError(
          body?.error === "phone_taken"
            ? "That number's already linked to another account."
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
      setDiscoverableState(Boolean(body.phoneDiscoverable));
      setPhoneInput("");
      setNewDiscoverable(false);
    } catch {
      setError("Couldn't save that number — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card flex flex-col gap-3 p-5">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Phone size={16} strokeWidth={1.8} className="text-muted" aria-hidden /> Phone discovery
          <span className="text-xs font-normal text-muted">(optional)</span>
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Only people who already know your number can find you with it. It&apos;s stored scrambled
          and never shown to anyone.
        </p>
      </div>

      {phoneLast2 ? (
        <p className="text-sm text-muted">
          •••• ••{phoneLast2} · {discoverableState ? "discoverable" : "not discoverable"} — manage it
          any time from Friends.
        </p>
      ) : (
        <form onSubmit={savePhone} className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={phoneInput}
              onChange={(event) => setPhoneInput(event.target.value)}
              inputMode="tel"
              placeholder="+1 555 123 4567"
              aria-label="Phone number"
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-border-subtle bg-surface px-3 text-sm outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent/60"
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
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Handle-or-phone lookup with an identity PREVIEW before anything happens —
 * following takes an explicit tap on the preview card, never the lookup
 * itself (docs/SOCIAL.md §7.2).
 */
function FriendLookup({ ownHandle }: { ownHandle: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<AddTarget | null>(null);
  const [followed, setFollowed] = useState<FollowedRow[]>([]);

  async function fetchTarget(handle: string): Promise<void> {
    const res = await fetch(`/api/social/add-target?handle=${encodeURIComponent(handle)}`);
    if (res.status === 404) {
      setStatus("No one's claimed that handle yet — check the spelling, or send them an invite the old way.");
      return;
    }
    const body = (await res.json().catch(() => null)) as { target?: AddTarget } | null;
    if (!res.ok || !body?.target) {
      setStatus("Couldn't look that up — try again.");
      return;
    }
    setPreview(body.target);
    setValue("");
  }

  async function handleLookup(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setStatus(null);
    setPreview(null);
    try {
      if (looksLikePhone(trimmed)) {
        const res = await fetch("/api/social/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone: trimmed }),
        });
        if (res.status === 429) {
          setStatus("Too many lookups — try again in a bit.");
          return;
        }
        if (res.status === 400) {
          setStatus("That doesn't look like a phone number.");
          return;
        }
        const body = (await res.json().catch(() => null)) as { profile?: ProfileSummary | null } | null;
        if (!res.ok || !body) {
          setStatus("Couldn't look that up — try again.");
          return;
        }
        if (!body.profile) {
          setStatus("No one found by that number. They may not have opted in — ask them for their @handle or code.");
          return;
        }
        await fetchTarget(body.profile.handle);
        return;
      }
      await fetchTarget(trimmed.replace(/^@/, "").toLowerCase());
    } catch {
      setStatus("Couldn't look that up — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFollow() {
    if (!preview || followBusy) return;
    setFollowBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/social/follows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: preview.profile.handle }),
      });
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setStatus(
          body?.error === "profile_required"
            ? "You need a handle first — go back a step to claim one."
            : "Couldn't follow right now — try again.",
        );
        return;
      }
      const body = (await res.json().catch(() => null)) as { state?: FollowState } | null;
      if (!res.ok || !body?.state) {
        setStatus("Couldn't follow — try again.");
        return;
      }
      setFollowed((rows) => [
        { profile: preview.profile, state: body.state as FollowState },
        ...rows.filter((r) => r.profile.userId !== preview.profile.userId),
      ]);
      setPreview(null);
    } catch {
      setStatus("Couldn't follow — try again.");
    } finally {
      setFollowBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <form onSubmit={handleLookup} className="card flex flex-col gap-3 p-4">
        <p className="section-label">Add a friend</p>
        <div className="flex items-center gap-2">
          <div className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-xl border border-border-subtle bg-surface px-3 focus-within:ring-2 focus-within:ring-accent/60">
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
            className="btn-secondary tap-target inline-flex min-h-11 items-center gap-1.5 px-4 text-sm disabled:opacity-60"
          >
            <SearchIcon size={16} strokeWidth={1.8} aria-hidden /> {busy ? "…" : "Find"}
          </button>
        </div>
        {status && (
          <p role="status" className="text-xs text-muted">
            {status}
          </p>
        )}
      </form>

      {preview && (
        <div className="card-flat flex items-center justify-between gap-3 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <UserAvatar
              name={preview.profile.displayName || preview.profile.handle}
              image={preview.profile.avatarUrl}
              size={40}
            />
            <span className="min-w-0">
              <span className="block truncate font-medium">
                {preview.profile.displayName || `@${preview.profile.handle}`}
              </span>
              <span className="flex items-center gap-1.5 truncate text-xs text-muted">
                @{preview.profile.handle}
                {preview.followsYou && <span className="chip px-2 py-0.5 text-[10px]">Follows you</span>}
              </span>
            </span>
          </div>
          {preview.isSelf || preview.profile.handle === ownHandle ? (
            <span className="shrink-0 text-xs text-muted">That&apos;s you</span>
          ) : preview.followState ? (
            <span className="chip shrink-0 px-3 py-1.5 text-xs">
              {preview.followState === "accepted" ? "Following" : "Requested"}
            </span>
          ) : (
            <button
              type="button"
              onClick={handleFollow}
              disabled={followBusy}
              className="btn-secondary tap-target inline-flex shrink-0 items-center gap-1.5 px-4 py-2 text-sm disabled:opacity-60"
            >
              <UserPlus size={16} strokeWidth={1.8} aria-hidden /> {followBusy ? "Following…" : "Follow"}
            </button>
          )}
        </div>
      )}

      {followed.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="People you followed">
          {followed.map((row) => (
            <li key={row.profile.userId} className="card-flat flex items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 items-center gap-3">
                <UserAvatar
                  name={row.profile.displayName || row.profile.handle}
                  image={row.profile.avatarUrl}
                  size={40}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {row.profile.displayName || `@${row.profile.handle}`}
                  </span>
                  <span className="block truncate text-xs text-muted">@{row.profile.handle}</span>
                </span>
              </div>
              <span className={`chip shrink-0 px-3 py-1.5 text-xs ${row.state === "accepted" ? "chip-active" : ""}`}>
                {row.state === "accepted" ? "Following" : "Requested"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Your first bottle
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 200;
const MAX_RESULTS = 5;

type AddedState = "own" | "wishlist";

function StepBottle({
  onFinish,
  onLeaveForScan,
}: {
  onFinish: () => void;
  onLeaveForScan: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BottleSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, AddedState>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        const res = await fetch(`/api/bottles/search?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`search failed (${res.status})`);
        const data = (await res.json()) as { results: BottleSearchResult[] };
        setResults(data.results.slice(0, MAX_RESULTS));
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError("Couldn't search the catalog — try again.");
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function addBottle(bottle: BottleSearchResult, relationship: AddedState) {
    if (busyId) return;
    setBusyId(bottle.id);
    setError(null);
    try {
      const res = await fetch("/api/user-bottles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bottleId: bottle.id, relationship }),
      });
      if (!res.ok) {
        setError("Couldn't add that bottle — try again.");
        return;
      }
      setAdded((prev) => ({ ...prev, [bottle.id]: relationship }));
    } catch {
      setError("Couldn't add that bottle — try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <StepHeading
        label="Step 4"
        title="Your first bottle"
        lede="Whatever's on your shelf — or the one you're wishing for. One is plenty to start."
      />

      <div className="relative">
        <SearchIcon
          size={18}
          strokeWidth={1.8}
          aria-hidden
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder='Try "eagle 10" or "lagavulin"'
          aria-label="Search bottles"
          className="w-full rounded-xl border border-border-subtle bg-surface py-3 pl-10 pr-4 text-sm text-foreground outline-none placeholder:text-muted transition-colors focus:border-accent/70"
        />
      </div>

      {error && (
        <p role="alert" className="card-flat p-4 text-sm text-muted">
          {error}
        </p>
      )}

      {results !== null && results.length === 0 && !error && (
        <p className="text-center text-sm text-muted">
          No bottles found — try fewer or shorter words.
        </p>
      )}

      {results !== null && results.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Bottle results">
          {results.map((bottle) => {
            const state = added[bottle.id];
            return (
              <li key={bottle.id} className="card-flat flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{bottle.name}</p>
                  <p className="truncate text-xs text-muted">
                    {categoryLabel(bottle.category)}
                    {bottle.distillery ? ` · ${bottle.distillery}` : ""}
                  </p>
                </div>
                {state ? (
                  <span className="chip chip-active flex shrink-0 items-center gap-1 px-3 py-1.5 text-xs">
                    <Check size={14} strokeWidth={1.8} aria-hidden />
                    {state === "own" ? "In your bar" : "Wishlisted"}
                  </span>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void addBottle(bottle, "own")}
                      disabled={busyId === bottle.id}
                      aria-label={`Add ${bottle.name} to bar`}
                      className="btn-secondary tap-target px-3 py-2 text-xs disabled:opacity-60"
                    >
                      Add to bar
                    </button>
                    <button
                      type="button"
                      onClick={() => void addBottle(bottle, "wishlist")}
                      disabled={busyId === bottle.id}
                      aria-label={`Wishlist ${bottle.name}`}
                      className="tap-target rounded-xl border border-border-subtle px-3 py-2 text-xs text-muted transition-colors hover:border-accent/60 hover:text-foreground disabled:opacity-60"
                    >
                      Wishlist
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Link
        href="/scan"
        onClick={onLeaveForScan}
        className="flex items-center justify-center gap-1.5 text-sm text-accent transition-opacity hover:opacity-90"
      >
        <ScanLine size={16} strokeWidth={1.8} aria-hidden /> Have the bottle in hand? Scan it
      </Link>

      <button type="button" onClick={onFinish} className="btn-primary w-full py-3.5">
        Finish
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function StepHeading({ label, title, lede }: { label: string; title: string; lede: string }) {
  return (
    <header>
      <p className="section-label">{label}</p>
      <h1 className="mt-1 font-display text-[2rem] font-semibold leading-tight">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">{lede}</p>
    </header>
  );
}

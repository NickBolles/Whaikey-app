"use client";

import { useState } from "react";
import { signIn } from "@/lib/auth-client";

type Provider = "google" | "apple";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81Z"
      />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z"
      />
    </svg>
  );
}

export default function SignInPage() {
  const oauthConfigured = process.env.NEXT_PUBLIC_OAUTH_CONFIGURED !== "false";
  const [pending, setPending] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn(provider: Provider) {
    if (pending) return;
    setPending(provider);
    setError(null);
    try {
      // On success better-auth redirects to `callbackURL`, so we intentionally
      // leave `pending` set — the page is on its way out. Only an error path
      // (blocked popup, network failure, misconfig) resolves/throws here.
      const res = await signIn.social({ provider, callbackURL: "/" });
      if (res && "error" in res && res.error) {
        setError(res.error.message ?? "Sign-in failed. Please try again.");
        setPending(null);
      }
    } catch {
      setError("Couldn't reach the sign-in service. Check your connection and try again.");
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[85dvh] px-6 gap-9">
      <div className="text-center">
        <div aria-hidden className="text-5xl mb-4 drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🥃
        </div>
        <h1 className="font-display text-4xl font-semibold tracking-tight text-gradient-amber">
          Whaikey
        </h1>
        <p className="text-muted mt-3 max-w-xs leading-relaxed">
          Your bar, your palate, your pours — with an AI concierge who knows them all.
        </p>
      </div>
      <div className="w-full max-w-xs flex flex-col gap-3">
        <button
          onClick={() => handleSignIn("google")}
          disabled={pending !== null}
          aria-busy={pending === "google"}
          className="btn-primary flex items-center justify-center gap-3 py-3.5 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <GoogleIcon /> {pending === "google" ? "Connecting…" : "Continue with Google"}
        </button>
        <button
          onClick={() => handleSignIn("apple")}
          disabled={pending !== null}
          aria-busy={pending === "apple"}
          className="btn-secondary flex items-center justify-center gap-3 py-3.5 font-medium disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <AppleIcon /> {pending === "apple" ? "Connecting…" : "Continue with Apple"}
        </button>
        {error && (
          <p role="alert" className="text-sm text-danger text-center mt-1 leading-relaxed">
            {error}
          </p>
        )}
        {!oauthConfigured && (
          <p className="text-xs text-muted text-center mt-2 leading-relaxed">
            OAuth isn&apos;t configured yet — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in
            .env.local.
          </p>
        )}
      </div>
      <p className="text-xs text-muted/70 text-center max-w-xs">
        Sip responsibly. Whaikey never rewards drinking frequency — only curiosity.
      </p>
    </div>
  );
}

"use client";

import { signIn } from "@/lib/auth-client";

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
  return (
    <div className="flex flex-col items-center justify-center min-h-[80dvh] px-6 gap-8">
      <div className="text-center">
        <div className="text-5xl mb-3">🥃</div>
        <h1 className="text-3xl font-bold tracking-tight">Whaikey</h1>
        <p className="text-muted mt-2 max-w-xs">
          Your bar, your palate, your pours — with an AI concierge who knows them all.
        </p>
      </div>
      <div className="w-full max-w-xs flex flex-col gap-3">
        <button
          onClick={() => signIn.social({ provider: "google", callbackURL: "/" })}
          className="flex items-center justify-center gap-3 rounded-xl bg-foreground text-background font-medium py-3 hover:opacity-90 transition-opacity"
        >
          <GoogleIcon /> Continue with Google
        </button>
        <button
          onClick={() => signIn.social({ provider: "apple", callbackURL: "/" })}
          className="flex items-center justify-center gap-3 rounded-xl border border-border-subtle bg-surface font-medium py-3 hover:bg-surface-raised transition-colors"
        >
          <AppleIcon /> Continue with Apple
        </button>
        {!oauthConfigured && (
          <p className="text-xs text-muted text-center mt-2">
            OAuth isn&apos;t configured yet — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.local.
          </p>
        )}
      </div>
      <p className="text-xs text-muted text-center max-w-xs">
        Sip responsibly. Whaikey never rewards drinking frequency — only curiosity.
      </p>
    </div>
  );
}

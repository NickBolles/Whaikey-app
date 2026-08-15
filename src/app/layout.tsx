import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { getDb } from "@/db";
import { getOwnProfile } from "@/lib/social";
import { getSessionUser } from "@/lib/session";
import { AppHeader } from "@/components/app-header";
import { AppNav } from "@/components/app-nav";
import { NativeShell } from "@/components/native-shell";

/**
 * Fonts are self-hosted from files committed under `src/app/fonts/`, not fetched
 * with `next/font/google`.
 *
 * `next/font/google` downloads from Google at build time, so a build gets
 * whatever revision Google is serving that day — the build is not reproducible.
 * When Google shipped a Fraunces revision in late July 2026 the glyph metrics
 * changed, every line of type re-wrapped, and the committed visual baselines
 * broke with no code change behind it (CI went red on `main` between two runs
 * four hours apart, the only commit between them touching a single ingest
 * client). Vendoring the files means the type can only change when someone
 * deliberately replaces them — a reviewable diff — which is what
 * docs/DESIGN.md's baseline workflow assumes.
 *
 * These are the exact latin-subset files Google was serving when the current
 * baselines were rendered, lifted out of a `next/font/google` build, so
 * vendoring them changed nothing visually. Both faces are OFL-1.1; the licence
 * texts sit beside them.
 */
const geistSans = localFont({
  src: "./fonts/geist-latin-variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: "Arial",
});
const geistMono = localFont({
  src: "./fonts/geist-mono-latin-variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: "Arial",
});
const fraunces = localFont({
  src: "./fonts/fraunces-latin-variable.woff2",
  variable: "--font-fraunces",
  weight: "100 900",
  display: "swap",
  // Display face is a serif, so the swap-time metric stand-in should be too.
  adjustFontFallback: "Times New Roman",
});

export const metadata: Metadata = {
  title: { default: "Whaikey", template: "%s · Whaikey" },
  description: "AI-native whiskey tracking: your bar, your palate, your pours.",
};

export const viewport: Viewport = {
  themeColor: "#14100b",
  width: "device-width",
  initialScale: 1,
  // The native shell draws under the notch and home indicator; the layout pays
  // that back with env(safe-area-inset-*) padding (globals.css).
  viewportFit: "cover",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Session + own-profile lookup for the global header. Every page under this
  // layout is force-dynamic already, so reading request headers here (inside
  // getSessionUser) changes nothing about rendering mode.
  const user = await getSessionUser();
  const profile = user ? await getOwnProfile(getDb(), user.id) : null;
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} antialiased`}
    >
      <body className="min-h-dvh">
        <NativeShell />
        <div className="mx-auto max-w-2xl min-h-dvh flex flex-col">
          <AppHeader
            user={user ? { name: user.name, image: user.image } : null}
            profileHandle={profile?.handle ?? null}
          />
          <main className="flex-1">{children}</main>
          <AppNav />
        </div>
      </body>
    </html>
  );
}

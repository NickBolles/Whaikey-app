import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AppNav } from "@/components/app-nav";
import { NativeShell } from "@/components/native-shell";

/**
 * Fonts are self-hosted from version-pinned packages rather than fetched with
 * `next/font/google`.
 *
 * `next/font/google` downloads from Google at build time, so the font files are
 * whatever Google is serving that day — the build is not reproducible. When
 * Google shipped a Fraunces revision in late July 2026 the glyph metrics changed,
 * every line of type re-wrapped, and the committed visual baselines broke with no
 * code change behind it (CI went red on `main` between two runs four hours apart,
 * the only commit between them touching a single ingest client). Pinning through
 * the lockfile means the type can only change when someone deliberately bumps a
 * dependency — a reviewable diff — which is what docs/DESIGN.md's baseline
 * workflow assumes.
 *
 * Fraunces uses the `full` variable file specifically because it carries the
 * `opsz` axis that `font-optical-sizing: auto` in globals.css depends on.
 */
const geistSans = localFont({
  src: "../../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: "Arial",
});
const geistMono = localFont({
  src: "../../node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: "Arial",
});
const fraunces = localFont({
  src: "../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2",
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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} antialiased`}
    >
      <body className="min-h-dvh">
        <NativeShell />
        <div className="mx-auto max-w-2xl min-h-dvh flex flex-col">
          <main className="flex-1">{children}</main>
          <AppNav />
        </div>
      </body>
    </html>
  );
}

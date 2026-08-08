import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import { AppNav } from "@/components/app-nav";
import { NativeShell } from "@/components/native-shell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: "variable",
  axes: ["opsz"],
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

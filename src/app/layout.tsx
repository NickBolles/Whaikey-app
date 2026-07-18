import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppNav } from "@/components/app-nav";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Whaikey", template: "%s · Whaikey" },
  description: "AI-native whiskey tracking: your bar, your palate, your pours.",
};

export const viewport: Viewport = {
  themeColor: "#16110c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-dvh">
        <div className="mx-auto max-w-2xl min-h-dvh flex flex-col">
          <main className="flex-1 pb-24">{children}</main>
          <AppNav />
        </div>
      </body>
    </html>
  );
}

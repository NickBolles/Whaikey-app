import type { Metadata } from "next";
import Link from "next/link";
import { Bell, ChevronRight } from "lucide-react";
import { getSessionUser } from "@/lib/session";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * The settings index. One entry today; it exists so notifications live at a
 * predictable address (`/settings/notifications`) rather than hanging off a
 * page that happens to have room for them, and so the next settings surface
 * has somewhere obvious to go.
 */
const SECTIONS = [
  {
    href: "/settings/notifications",
    label: "Notifications",
    description: "Alerts, quiet hours, and per-device settings.",
    icon: Bell,
  },
] as const;

export default async function SettingsPage() {
  const user = await getSessionUser();

  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          ⚙️
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">Settings</h1>
          <p className="mt-2 max-w-sm text-muted">Sign in to manage your account.</p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 pt-5">
      <header>
        <h1 className="font-display text-[2rem] font-semibold leading-tight">Settings</h1>
        <p className="mt-1 text-muted">{user.email}</p>
      </header>

      <nav aria-label="Settings sections" className="flex flex-col gap-3">
        {SECTIONS.map(({ href, label, description, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="card flex items-center gap-4 p-5 transition-[filter] hover:brightness-110"
          >
            <Icon size={22} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-display text-lg font-semibold">{label}</span>
              <span className="mt-0.5 block text-sm text-muted">{description}</span>
            </span>
            <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
          </Link>
        ))}
      </nav>
    </div>
  );
}

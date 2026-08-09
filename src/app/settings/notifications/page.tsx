import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { buildSettingsView } from "@/lib/notifications/view";
import { NotificationsClient } from "./notifications-client";

export const metadata: Metadata = { title: "Notifications" };

// Device health and quiet-hours state are both time-dependent, so this screen
// must never be served from a cache — a stale "everything is fine" is exactly
// the lie it exists to prevent.
export const dynamic = "force-dynamic";

export default async function NotificationSettingsPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🔔
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">Notification settings</h1>
          <p className="mt-2 max-w-sm text-muted">
            Sign in to choose what you hear about, and on which devices.
          </p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const view = await buildSettingsView(getDb(), user.id);

  return (
    <div className="flex flex-col gap-6 px-4 pt-5">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground"
        >
          <ChevronLeft size={16} strokeWidth={1.8} aria-hidden />
          Settings
        </Link>
        <h1 className="mt-2 font-display text-[2rem] font-semibold leading-tight">Notifications</h1>
        <p className="mt-1 text-muted">
          What reaches you, where it reaches you, and when it doesn&rsquo;t.
        </p>
      </div>

      <NotificationsClient initial={view} />
    </div>
  );
}

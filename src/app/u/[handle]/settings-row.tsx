import Link from "next/link";
import { ChevronRight, Link2, Settings } from "lucide-react";
import type { PourVisibility } from "@/db/schema";

const VISIBILITY_LABEL: Record<PourVisibility, string> = {
  private: "Only me",
  friends: "Friends",
  followers: "Followers",
  public: "Public",
};

/**
 * The owner's "Sharing · Settings" row (STORYBOARD D13, §3.7): directly under
 * the palate card, own profile only. Sharing summarises what is out there —
 * live links and the default for new pours — and both halves land on
 * `/settings`, where `/sharing` now lives.
 */
export function OwnSettingsRow({
  shareCount,
  defaultVisibility,
}: {
  shareCount: number;
  defaultVisibility: PourVisibility;
}) {
  return (
    <nav aria-label="Sharing and settings" className="grid grid-cols-2 gap-2">
      <Link
        href="/settings#sharing"
        className="card-flat flex min-h-11 items-center gap-2.5 rounded-2xl p-3 transition-colors hover:border-accent/40"
      >
        <Link2 size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Sharing</span>
          <span className="block truncate text-xs text-muted">
            {shareCount} link{shareCount === 1 ? "" : "s"} · {VISIBILITY_LABEL[defaultVisibility]}
          </span>
        </span>
        <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
      </Link>
      <Link
        href="/settings"
        className="card-flat flex min-h-11 items-center gap-2.5 rounded-2xl p-3 transition-colors hover:border-accent/40"
      >
        <Settings size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Settings</span>
          <span className="block truncate text-xs text-muted">Account, data</span>
        </span>
        <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
      </Link>
    </nav>
  );
}

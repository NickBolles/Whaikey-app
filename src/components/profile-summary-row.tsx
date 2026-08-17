import type { ReactNode } from "react";
import Link from "next/link";
import { UserAvatar } from "@/components/user-avatar";
import type { ProfileSummary } from "@/lib/social";

/**
 * The shared row shape for every friends/followers/requests/blocked list:
 * avatar + display name + @handle, linking to the profile. `right` holds
 * per-row actions (approve/deny, unfollow, unblock…); `subtitle` holds a
 * small trailing note (e.g. a "Friends" chip) next to the handle.
 */
export function ProfileSummaryRow({
  profile,
  right,
  subtitle,
}: {
  profile: ProfileSummary;
  right?: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <li className="card-flat flex items-center justify-between gap-3 p-4">
      <Link
        href={`/u/${profile.handle}`}
        className="flex min-w-0 items-center gap-3 transition-opacity hover:opacity-90"
      >
        <UserAvatar name={profile.displayName || profile.handle} image={profile.avatarUrl} size={40} />
        <span className="min-w-0">
          <span className="block truncate font-medium">{profile.displayName || profile.handle}</span>
          <span className="flex items-center gap-1.5 truncate text-xs text-muted">
            @{profile.handle}
            {subtitle}
          </span>
        </span>
      </Link>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </li>
  );
}

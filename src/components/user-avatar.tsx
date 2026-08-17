/* eslint-disable @next/next/no-img-element */

/**
 * Shared avatar for every social surface. OAuth avatars come from
 * user.image / userProfiles.avatarUrl; the fallback is an initial on a warm
 * surface so a graph of mostly-avatarless friends still reads as people.
 */
export function UserAvatar({
  name,
  image,
  size = 32,
}: {
  name: string;
  image?: string | null;
  size?: number;
}) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  if (image) {
    return (
      <img
        src={image}
        alt=""
        width={size}
        height={size}
        className="rounded-full border border-[var(--border)] object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-raised)] font-display text-[var(--accent)]"
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.45)) }}
    >
      {initial}
    </span>
  );
}

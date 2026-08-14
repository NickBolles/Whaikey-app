import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { getAddTarget } from "@/lib/social";
import { UserAvatar } from "@/components/user-avatar";
import { AddConfirmClient } from "./add-confirm-client";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ handle: string }> };

/**
 * Every add path — handle, phone lookup, QR — lands here (docs/SOCIAL.md
 * §7.2, binding). This is a human-facing landing page reachable from a
 * shared/printed code, never indexed.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  return { title: `Add @${handle}`, robots: { index: false, follow: false } };
}

export default async function AddPage({ params }: Props) {
  const { handle } = await params;
  const user = await getSessionUser();

  // The QR/link is shareable, so this WILL be hit signed-out — no target
  // lookup happens without a viewer to scope it to.
  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🥃
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">Add @{handle}</h1>
          <p className="mt-2 max-w-sm text-muted">
            Sign in to Whaikey, then come back to this link to add them.
          </p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const db = getDb();
  const target = await getAddTarget(db, user.id, handle);

  if (!target) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 pb-24 pt-16 text-center">
        <div aria-hidden className="text-5xl">
          🔍
        </div>
        <h1 className="font-display text-2xl font-semibold">No one by that handle</h1>
        <p className="max-w-sm text-muted">Codes expire when accounts close.</p>
        <Link href="/friends" className="btn-secondary mt-2 px-6 py-2.5 text-sm">
          Back to Friends
        </Link>
      </div>
    );
  }

  if (target.isSelf) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 pb-24 pt-16 text-center">
        <UserAvatar
          name={target.profile.displayName || target.profile.handle}
          image={target.profile.avatarUrl}
          size={72}
        />
        <h1 className="font-display text-2xl font-semibold">That&apos;s your own code</h1>
        <p className="max-w-sm text-muted">Share it with a friend so they can add you.</p>
        <Link href={`/u/${target.profile.handle}`} className="btn-secondary mt-2 px-6 py-2.5 text-sm">
          View your profile
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 pb-24 pt-16">
      <AddConfirmClient target={target} />
    </div>
  );
}

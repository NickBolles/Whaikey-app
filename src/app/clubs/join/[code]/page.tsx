import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { previewInvite } from "@/lib/clubs";
import { JoinClubButton } from "@/components/social/club-actions";

export const dynamic = "force-dynamic";

/** An invite link's landing page. Needs an account (clubs are for people with profiles). */
export default async function JoinClubPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="font-display text-2xl font-semibold">You&rsquo;re invited to a club</h1>
        <p className="max-w-sm text-sm text-muted">Sign in to see which one and join.</p>
        <Link href={`/sign-in?next=${encodeURIComponent(`/clubs/join/${code}`)}`} className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }
  const preview = await previewInvite(getDb(), user.id, code);
  if (preview?.alreadyMember) redirect(`/clubs/${preview.clubId}`);
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-6 text-center">
      {preview ? (
        <>
          <h1 className="font-display text-2xl font-semibold">{preview.clubName}</h1>
          <p className="text-sm text-muted">
            {preview.memberCount} {preview.memberCount === 1 ? "member" : "members"} · invite-only
          </p>
          <JoinClubButton code={code} />
        </>
      ) : (
        <>
          <h1 className="font-display text-2xl font-semibold">This invite has expired</h1>
          <p className="max-w-sm text-sm text-muted">Invites last a week and can be withdrawn. Ask for a fresh link.</p>
          <Link href="/clubs" className="btn-secondary px-6 py-2.5 text-sm">
            Your clubs
          </Link>
        </>
      )}
    </div>
  );
}

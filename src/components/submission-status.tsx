import Link from "next/link";
import type { BottleSubmissionState } from "@/db/schema";

/**
 * What happened to a bottle you added (PLAN.md §9.4, review PLAN-A1).
 *
 * Only its submitter sees this. WP-16 told people their bottle "joins the
 * shared catalog once someone has checked it over" and then had nowhere to say
 * whether anyone had — and WP-18's review path requires a reason for a decline,
 * which is a reason in name only if the person it is addressed to cannot read
 * it. An approved submission says nothing at all: the bottle is simply in the
 * catalog, which is the outcome, and a banner announcing it would be noise on
 * every future visit.
 */
export function SubmissionStatus({
  state,
  reviewNote,
  duplicateOfBottleId,
}: {
  state: BottleSubmissionState;
  reviewNote: string | null;
  duplicateOfBottleId: string | null;
}) {
  if (state === "approved") return null;

  const headline =
    state === "pending"
      ? "You added this bottle. It's yours to use right now."
      : state === "duplicate"
        ? "We already had this one."
        : "This one didn't make it into the shared catalog.";

  const detail =
    state === "pending"
      ? "It joins the shared catalog once someone has checked it over. Until then it's visible only to you, and it doesn't count toward passport stamps."
      : "It stays on your shelf and in your journal exactly as it is — only the shared catalog listing was declined.";

  return (
    <section
      aria-label="Submission status"
      className="card-flat p-4 flex flex-col gap-1.5 border-l-2 border-accent/40"
    >
      <p className="text-sm font-medium">{headline}</p>
      <p className="text-sm text-muted leading-relaxed">{detail}</p>
      {reviewNote && <p className="text-sm text-muted italic leading-relaxed">“{reviewNote}”</p>}
      {duplicateOfBottleId && (
        <Link
          href={`/bottles/${duplicateOfBottleId}`}
          className="text-sm text-accent hover:underline w-fit"
        >
          See the one we have →
        </Link>
      )}
    </section>
  );
}

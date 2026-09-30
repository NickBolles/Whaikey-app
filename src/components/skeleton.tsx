/**
 * Loading skeletons for the `loading.tsx` files (docs/STORYBOARD.md §1.2:
 * "a tab tap paints within 100 ms"; review UX-12 / REL-6.2).
 *
 * Server components, no data: each route's skeleton is prefetched with the
 * route and painted the moment a tap lands, then swapped for the page when
 * its queries finish. The shapes echo the page they stand in for — same
 * padding, same card recipe — so the swap reads as content arriving rather
 * than a layout jump. The pulse is an opacity animation and only runs when
 * the user has not asked for reduced motion (DESIGN.md rule 9).
 */

export function Bone({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`rounded-xl bg-surface-raised motion-safe:animate-pulse ${className}`} />;
}

/** The page frame: announces what is loading, once, to assistive tech. */
export function SkeletonPage({
  label,
  className = "px-4 pt-5",
  children,
}: {
  /** e.g. "Loading your bar" — read out instead of the grey shapes. */
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={`flex flex-col gap-6 ${className}`}>
      {children}
    </div>
  );
}

/** A list of `card-flat` rows: a title line and a muted line under it. */
export function SkeletonRows({ count = 4, trailing = false }: { count?: number; trailing?: boolean }) {
  return (
    <ul aria-hidden className="flex flex-col gap-2.5">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="card-flat flex items-center gap-3 p-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Bone className={`h-4 ${i % 2 === 0 ? "w-3/5" : "w-2/5"}`} />
            <Bone className="h-3 w-1/4" />
          </div>
          {trailing && <Bone className="h-8 w-14 rounded-full" />}
        </li>
      ))}
    </ul>
  );
}

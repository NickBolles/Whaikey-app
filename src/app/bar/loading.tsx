import { Bone, SkeletonPage, SkeletonRows } from "@/components/skeleton";

/** My Bar while the shelf and its flavor heat load (docs/STORYBOARD.md §1.2). */
export default function BarLoading() {
  return (
    <SkeletonPage label="Loading your bar">
      <div aria-hidden className="flex items-end justify-between">
        <Bone className="h-8 w-32" />
        <Bone className="h-4 w-20" />
      </div>
      {/* Stats */}
      <div aria-hidden className="grid grid-cols-3 gap-3">
        <Bone className="h-16" />
        <Bone className="h-16" />
        <Bone className="h-16" />
      </div>
      {/* Filter line */}
      <div aria-hidden className="flex gap-2">
        <Bone className="h-9 w-16 rounded-full" />
        <Bone className="h-9 w-16 rounded-full" />
        <Bone className="h-9 w-20 rounded-full" />
        <Bone className="h-9 w-20 rounded-full" />
      </div>
      <SkeletonRows count={5} />
    </SkeletonPage>
  );
}

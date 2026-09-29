import { Bone, SkeletonPage, SkeletonRows } from "@/components/skeleton";

/**
 * Home's first paint while the month in review, the feed and the journal load
 * (docs/STORYBOARD.md §1.2). In a route group so it covers `/` alone: a
 * `loading.tsx` at the app root would wrap every route in Home's shape.
 */
export default function HomeLoading() {
  return (
    <SkeletonPage label="Loading your home" className="px-4 pt-5 gap-7">
      {/* Month in review */}
      <div aria-hidden className="card flex flex-col gap-4 p-5">
        <Bone className="h-3 w-24" />
        <Bone className="h-8 w-2/3" />
        <div className="grid grid-cols-3 gap-3">
          <Bone className="h-14" />
          <Bone className="h-14" />
          <Bone className="h-14" />
        </div>
      </div>
      {/* Tonight's pour */}
      <div aria-hidden className="card flex items-center gap-4 p-5">
        <Bone className="h-20 w-14 shrink-0" />
        <div className="flex flex-1 flex-col gap-2">
          <Bone className="h-3 w-28" />
          <Bone className="h-5 w-3/4" />
          <Bone className="h-3 w-1/2" />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Bone className="h-3 w-28" />
        <SkeletonRows count={3} trailing />
      </div>
    </SkeletonPage>
  );
}

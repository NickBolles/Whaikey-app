import { Bone, SkeletonPage, SkeletonRows } from "@/components/skeleton";

/** A profile while its palate, passport and notes load (docs/STORYBOARD.md §1.2). */
export default function ProfileLoading() {
  return (
    <SkeletonPage label="Loading profile" className="mx-auto w-full max-w-lg px-4 pb-24 pt-8">
      <div aria-hidden className="flex items-center gap-3">
        <Bone className="h-16 w-16 shrink-0 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Bone className="h-6 w-1/2" />
          <Bone className="h-3 w-1/4" />
        </div>
      </div>
      <div aria-hidden className="card flex flex-col items-center gap-3 p-5">
        <Bone className="h-3 w-16 self-start" />
        <Bone className="aspect-square w-full max-w-[280px] rounded-full" />
      </div>
      <div className="flex flex-col gap-3">
        <Bone className="h-3 w-28" />
        <SkeletonRows count={3} />
      </div>
    </SkeletonPage>
  );
}

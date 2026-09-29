import { Bone, SkeletonPage, SkeletonRows } from "@/components/skeleton";

/** The journal while its pours load (docs/STORYBOARD.md §1.2). */
export default function HistoryLoading() {
  return (
    <SkeletonPage label="Loading your journal" className="mx-auto w-full max-w-lg px-4 pt-8 pb-24">
      <div aria-hidden className="flex flex-col gap-2">
        <Bone className="h-8 w-52" />
        <Bone className="h-3 w-28" />
      </div>
      <SkeletonRows count={5} />
    </SkeletonPage>
  );
}

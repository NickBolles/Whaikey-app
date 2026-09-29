import { Bone, SkeletonPage } from "@/components/skeleton";

/** A bottle page while its detail, palate match and history load (docs/STORYBOARD.md §1.2). */
export default function BottleLoading() {
  return (
    <SkeletonPage label="Loading bottle" className="px-4 pt-6 pb-10">
      {/* Hero: name, distillery, meta line, stamps */}
      <div aria-hidden className="flex flex-col gap-2.5">
        <div className="flex items-start justify-between gap-3">
          <Bone className="h-9 w-3/4" />
          <Bone className="h-7 w-20 rounded-full" />
        </div>
        <Bone className="h-4 w-1/3" />
        <Bone className="h-3 w-1/2" />
        <div className="mt-1 flex gap-2">
          <Bone className="h-[34px] w-[34px] rounded-full" />
          <Bone className="h-[34px] w-[34px] rounded-full" />
          <Bone className="h-[34px] w-[34px] rounded-full" />
        </div>
      </div>
      {/* Prices */}
      <div aria-hidden className="grid grid-cols-2 gap-3">
        <div className="card flex flex-col gap-2 p-4">
          <Bone className="h-6 w-14" />
          <Bone className="h-3 w-10" />
        </div>
        <div className="card flex flex-col gap-2 p-4">
          <Bone className="h-6 w-14" />
          <Bone className="h-3 w-24" />
        </div>
      </div>
      {/* Flavor profile */}
      <div aria-hidden className="flex flex-col gap-3">
        <Bone className="h-3 w-24" />
        <div className="card flex justify-center p-4">
          <Bone className="aspect-square w-full max-w-[260px] rounded-full" />
        </div>
      </div>
    </SkeletonPage>
  );
}

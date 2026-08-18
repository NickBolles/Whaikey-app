import { ExternalLink } from "lucide-react";
import type { BottleDetail } from "@/lib/search";

type Resource = BottleDetail["resources"][number];
type Media = BottleDetail["media"][number];

const RESOURCE_LABELS: Record<Resource["resourceType"], string> = {
  official_product: "Official product",
  producer: "Producer",
  distillery: "Distillery",
  review: "Review",
  retailer: "Retailer",
  registry: "Registry record",
};

function retrievedLabel(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Source on file";
  return `Checked ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)}`;
}

function ResourceList({ title, resources }: { title: string; resources: Resource[] }) {
  if (resources.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className="section-label mb-2.5">{title}</h3>
      <ul className="flex flex-col gap-2">
        {resources.map((resource) => {
          const label = RESOURCE_LABELS[resource.resourceType];
          const linkName = resource.title ? `${label}: ${resource.title}` : `${label}: ${resource.source.name}`;
          return (
            <li key={resource.id}>
              <a
                href={resource.url}
                target="_blank"
                rel="noopener noreferrer"
                className="card flex min-h-14 items-center justify-between gap-3 p-3.5 transition-colors hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium leading-snug">{linkName}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {resource.source.name} · {retrievedLabel(resource.retrievedAt)}
                  </span>
                </span>
                <ExternalLink aria-hidden size={17} className="shrink-0 text-muted" />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SourceImage({ media, bottleName }: { media: Media; bottleName: string }) {
  return (
    <figure className="card overflow-hidden">
      <div className="flex min-h-56 items-center justify-center bg-gradient-to-b from-accent/10 to-transparent p-5">
        {/* External source images are deliberately rendered only for display_remote policy rows. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media.url}
          alt={media.alt || `${bottleName} ${media.kind === "distillery" ? "distillery" : "bottle"}`}
          width={media.width ?? undefined}
          height={media.height ?? undefined}
          loading="lazy"
          referrerPolicy="no-referrer"
          className={media.kind === "bottle" ? "max-h-72 w-auto object-contain" : "max-h-64 w-full rounded-lg object-cover"}
        />
      </div>
      {media.attribution && (
        <figcaption className="border-t border-border px-3 py-2 text-[11px] text-muted">
          Image: {media.attribution}
        </figcaption>
      )}
    </figure>
  );
}

export function SourceBackedResources({
  bottleName,
  resources,
  media,
}: {
  bottleName: string;
  resources: Resource[];
  media: Media[];
}) {
  const displayable = media.filter((item) => item.rights === "display_remote");
  const bottleImage = displayable.find((item) => item.kind === "bottle" && item.isPrimary) ??
    displayable.find((item) => item.kind === "bottle");
  const distilleryImage = displayable.find((item) => item.kind === "distillery");
  const official = resources.filter((resource) => resource.source.kind !== "editorial" && resource.resourceType !== "review");
  const reviews = resources.filter((resource) => resource.source.kind === "editorial" || resource.resourceType === "review");

  if (!bottleImage && !distilleryImage && resources.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      {bottleImage && <SourceImage media={bottleImage} bottleName={bottleName} />}

      {(official.length > 0 || reviews.length > 0) && (
        <section aria-label="Sources" className="flex flex-col gap-4">
          <div>
            <h2 className="section-label">Sources & more</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              Facts and images stay attributed to their publishers. Open a source for the full breakdown.
            </p>
          </div>
          <ResourceList title="Official sources" resources={official} />
          <ResourceList title="Independent reviews" resources={reviews} />
        </section>
      )}

      {distilleryImage && (
        <section aria-label="Distillery image">
          <h2 className="section-label mb-3">From the distillery</h2>
          <SourceImage media={distilleryImage} bottleName={bottleName} />
        </section>
      )}
    </div>
  );
}

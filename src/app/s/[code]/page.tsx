import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Star } from "lucide-react";
import { getDb } from "@/db";
import { getPublicPourShare } from "@/lib/pour-sharing";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const share = await getPublicPourShare(getDb(), code);
  if (!share) return { title: "Tasting note not found", robots: { index: false, follow: false } };
  const description = share.note.freeform ?? share.note.nose ?? share.note.palate ?? `A tasting note from ${share.ownerName}.`;
  return {
    title: `${share.bottleName} tasting note`,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      title: `${share.ownerName}'s ${share.bottleName} tasting note`,
      description,
      images: [{ url: `/s/${share.code}/opengraph-image`, width: 1200, height: 630, alt: `${share.bottleName} tasting note` }],
    },
    twitter: { card: "summary_large_image", title: `${share.bottleName} tasting note`, description, images: [`/s/${share.code}/opengraph-image`] },
  };
}

export default async function SharedPourPage({ params }: Props) {
  const { code } = await params;
  const share = await getPublicPourShare(getDb(), code);
  if (!share) notFound();
  const noteParts = [["Nose", share.note.nose], ["Palate", share.note.palate], ["Finish", share.note.finish]].filter((part): part is [string, string] => Boolean(part[1]));

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 py-12">
      <header className="space-y-2">
        <p className="section-label">Shared from Whaikey</p>
        <h1 className="font-display text-4xl font-semibold leading-tight">{share.bottleName}</h1>
        <p className="text-muted">{share.ownerName}&apos;s tasting note</p>
      </header>
      <article className="card flex flex-col gap-5 p-5">
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
          {share.pour.rating != null && <span className="flex items-center gap-1 text-accent"><Star size={15} fill="currentColor" aria-hidden /> {share.pour.rating.toFixed(1)}</span>}
          {share.pour.servingStyle && <span className="capitalize">{share.pour.servingStyle}</span>}
          {share.pour.amountMl != null && <span>{share.pour.amountMl} ml</span>}
        </div>
        {noteParts.map(([label, value]) => <section key={label}><h2 className="section-label mb-1">{label}</h2><p className="text-foreground/90">{value}</p></section>)}
        {share.note.freeform && <blockquote className="border-l-2 border-accent/70 pl-4 font-display text-lg italic text-foreground/90">{share.note.freeform}</blockquote>}
        {noteParts.length === 0 && !share.note.freeform && <p className="text-muted">A moment from {share.ownerName}&apos;s tasting journal.</p>}
      </article>
      <p className="text-center text-xs text-muted">Shared intentionally by its author · Whaikey</p>
    </div>
  );
}

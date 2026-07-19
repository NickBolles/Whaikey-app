import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { allLessons, getLesson, getTrackForLesson, nextLesson } from "@/lib/education";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import { warmify } from "@/components/wheel-geometry";
import { LessonQuiz } from "@/components/lesson-quiz";

export function generateStaticParams() {
  return allLessons().map((lesson) => ({ slug: lesson.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const lesson = getLesson(slug);
  return { title: lesson ? lesson.title : "Whiskey School" };
}

export default async function LessonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const lesson = getLesson(slug);
  if (!lesson) notFound();

  const track = getTrackForLesson(slug);
  const next = nextLesson(slug);
  const relatedWedges = (lesson.relatedWedgeIds ?? [])
    .map((id) => FLAVOR_WHEEL.find((w) => w.id === id))
    .filter((w) => w !== undefined);

  return (
    <div className="px-4 pt-5 flex flex-col gap-7">
      <header>
        <Link
          href="/learn"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground transition-colors -ml-1 py-2"
        >
          <ChevronLeft size={18} strokeWidth={1.8} aria-hidden /> Whiskey School
        </Link>
        <div className="mt-3 flex items-start gap-3">
          <span aria-hidden className="text-4xl leading-none drop-shadow-[0_0_16px_rgba(232,161,60,0.2)]">
            {lesson.emoji}
          </span>
          <div>
            <h1 className="font-display text-[1.7rem] leading-tight font-semibold">{lesson.title}</h1>
            <p className="flex items-center gap-3 text-xs text-muted mt-2">
              {track && <span>{track.title}</span>}
              <span className="flex items-center gap-1">
                <Clock size={13} strokeWidth={1.8} aria-hidden /> {lesson.minutes} min read
              </span>
            </p>
          </div>
        </div>
      </header>

      <article className="flex flex-col gap-6">
        {lesson.sections.map((section) => (
          <section key={section.heading}>
            <h2 className="font-display text-xl font-semibold mb-2.5">{section.heading}</h2>
            <div className="flex flex-col gap-3">
              {section.paragraphs.map((p, i) => (
                <p key={i} className="text-[15px] leading-relaxed text-foreground/90">
                  {p}
                </p>
              ))}
              {section.bullets && (
                <ul className="flex flex-col gap-2.5">
                  {section.bullets.map((b, i) => (
                    <li key={i} className="flex gap-2.5 text-[15px] leading-relaxed text-foreground/90">
                      <span aria-hidden className="mt-2 h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ))}
      </article>

      {lesson.keyTerms.length > 0 && (
        <section aria-label="Key terms" className="card p-5">
          <h2 className="section-label mb-3">Key terms</h2>
          <dl className="flex flex-col gap-3">
            {lesson.keyTerms.map((kt) => (
              <div key={kt.term}>
                <dt className="font-medium text-sm">{kt.term}</dt>
                <dd className="text-sm text-muted leading-relaxed mt-0.5">{kt.definition}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {relatedWedges.length > 0 && (
        <section aria-label="Related flavors">
          <h2 className="section-label mb-3">On the flavor wheel</h2>
          <Link href="/learn/flavors" className="flex flex-wrap gap-2">
            {relatedWedges.map((wedge) => (
              <span key={wedge.id} className="chip flex items-center gap-1.5 px-3 py-1.5 text-xs">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: warmify(wedge.color) }}
                  aria-hidden
                />
                {wedge.label}
              </span>
            ))}
          </Link>
        </section>
      )}

      <LessonQuiz lessonSlug={lesson.slug} questions={lesson.quiz} />

      {next ? (
        <Link
          href={`/learn/${next.slug}`}
          className="card flex items-center gap-4 p-5 hover:brightness-110 transition-[filter]"
        >
          <span aria-hidden className="text-2xl leading-none">
            {next.emoji}
          </span>
          <span className="flex-1 min-w-0">
            <span className="section-label block">Up next</span>
            <span className="font-display text-lg font-semibold block mt-0.5">{next.title}</span>
          </span>
          <ChevronRight size={18} strokeWidth={1.8} className="text-muted shrink-0" aria-hidden />
        </Link>
      ) : (
        <Link
          href="/learn"
          className="card flex items-center justify-center gap-2 p-5 text-sm text-muted hover:text-foreground transition-colors"
        >
          <ChevronLeft size={16} strokeWidth={1.8} aria-hidden /> That&apos;s the whole curriculum —
          back to Whiskey School
        </Link>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { Check, ChevronRight, Disc3 } from "lucide-react";
import { TRACKS, allLessons } from "@/lib/education";
import { useLearnProgress } from "@/lib/learn-progress";

export function LearnHub() {
  const { completed } = useLearnProgress();
  const total = allLessons().length;
  const done = allLessons().filter((l) => completed.has(l.slug)).length;

  return (
    <div className="px-4 pt-5 flex flex-col gap-7">
      <header>
        <p className="section-label mb-2">Whiskey School</p>
        <h1 className="font-display text-[2rem] leading-tight font-semibold">
          Learn whiskey, <span className="text-gradient-amber">one pour at a time</span>
        </h1>
        <p className="text-muted mt-2 leading-relaxed">
          Short lessons, honest quizzes, and a flavor wheel you can explore. No streaks, no
          pressure — just a sharper palate.
        </p>
      </header>

      <section aria-label="Your progress" className="card p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="section-label">Your progress</h2>
          <span className="stat-number text-xl leading-none text-accent">
            {done}
            <span className="text-muted text-sm">/{total}</span>
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label="Lessons completed"
          className="mt-3 h-1.5 rounded-full bg-background overflow-hidden"
        >
          <div
            className="h-full rounded-full bg-linear-to-r from-accent to-accent-deep transition-[width]"
            style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
          />
        </div>
        <p className="text-xs text-muted mt-2.5">
          {done === 0
            ? "Fresh glass. Start with Whiskey 101 below."
            : done === total
              ? "Curriculum complete — your palate thanks you."
              : "Progress lives on this device. Lessons finish when you take the quiz."}
        </p>
      </section>

      <Link
        href="/learn/flavors"
        className="card flex items-center gap-4 p-5 hover:brightness-110 transition-[filter]"
      >
        <Disc3 size={22} strokeWidth={1.8} className="text-accent shrink-0" aria-hidden />
        <span className="flex-1">
          <span className="font-display text-lg font-semibold block">Flavor wheel explorer</span>
          <span className="text-sm text-muted block mt-0.5">
            Tour the eight families — where each flavor comes from and how to spot it.
          </span>
        </span>
        <ChevronRight size={18} strokeWidth={1.8} className="text-muted shrink-0" aria-hidden />
      </Link>

      {TRACKS.map((track) => (
        <section key={track.id} aria-label={track.title}>
          <h2 className="section-label mb-1">{track.title}</h2>
          <p className="text-sm text-muted mb-3">{track.description}</p>
          <ul className="flex flex-col gap-2.5">
            {track.lessons.map((lesson) => {
              const isDone = completed.has(lesson.slug);
              return (
                <li key={lesson.slug}>
                  <Link
                    href={`/learn/${lesson.slug}`}
                    className="card-flat flex items-center gap-3.5 p-4 hover:bg-surface-raised transition-colors"
                  >
                    <span aria-hidden className="text-2xl leading-none">
                      {lesson.emoji}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="font-medium block">{lesson.title}</span>
                      <span className="text-xs text-muted block mt-0.5 leading-relaxed">
                        {lesson.teaser}
                      </span>
                    </span>
                    {isDone ? (
                      <span className="flex items-center gap-1 text-accent text-xs shrink-0">
                        <Check size={16} strokeWidth={2.2} aria-hidden /> Done
                      </span>
                    ) : (
                      <span className="chip px-2.5 py-1 text-[11px] shrink-0">
                        {lesson.minutes} min
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <p className="text-xs text-muted/70 text-center pb-2">
        Taste with attention, not volume. Sip responsibly.
      </p>
    </div>
  );
}

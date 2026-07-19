"use client";

import { useEffect, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import type { QuizQuestion } from "@/lib/education";
import { useLearnProgress } from "@/lib/learn-progress";

export interface LessonQuizProps {
  lessonSlug: string;
  questions: QuizQuestion[];
}

/**
 * End-of-lesson knowledge check: answer each question once, get instant
 * feedback + explanation. Finishing the quiz (any score) marks the lesson
 * complete — progress rewards showing up to learn, not acing it.
 */
export function LessonQuiz({ lessonSlug, questions }: LessonQuizProps) {
  const [answers, setAnswers] = useState<Array<number | null>>(() => questions.map(() => null));
  const { completed, markComplete } = useLearnProgress();

  const answeredCount = answers.filter((a) => a !== null).length;
  const allAnswered = answeredCount === questions.length;
  const score = answers.filter((a, i) => a === questions[i].answerIndex).length;

  useEffect(() => {
    if (allAnswered) markComplete(lessonSlug);
  }, [allAnswered, lessonSlug, markComplete]);

  return (
    <section aria-label="Knowledge check" className="card p-5 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl font-semibold">Quick quiz</h2>
        <span className="text-xs text-muted">
          {answeredCount}/{questions.length} answered
        </span>
      </div>

      {questions.map((q, qi) => {
        const chosen = answers[qi];
        const answered = chosen !== null;
        return (
          <fieldset key={qi} className="flex flex-col gap-2.5">
            <legend className="text-sm font-medium leading-snug mb-2.5">
              {qi + 1}. {q.prompt}
            </legend>
            {q.options.map((option, oi) => {
              const isChosen = chosen === oi;
              const isCorrect = oi === q.answerIndex;
              const showState = answered && (isChosen || isCorrect);
              return (
                <button
                  key={oi}
                  type="button"
                  disabled={answered}
                  aria-pressed={isChosen}
                  onClick={() =>
                    setAnswers((cur) => cur.map((a, i) => (i === qi ? oi : a)))
                  }
                  className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors min-h-11 ${
                    showState
                      ? isCorrect
                        ? "border-success/70 bg-success/10 text-foreground"
                        : "border-danger/70 bg-danger/10 text-foreground"
                      : answered
                        ? "border-border-subtle bg-surface text-muted"
                        : "border-border-subtle bg-surface hover:bg-surface-raised"
                  }`}
                >
                  <span>{option}</span>
                  {showState &&
                    (isCorrect ? (
                      <Check size={18} strokeWidth={1.8} className="shrink-0 text-success" aria-hidden />
                    ) : (
                      <X size={18} strokeWidth={1.8} className="shrink-0 text-danger" aria-hidden />
                    ))}
                </button>
              );
            })}
            {answered && (
              <p className="text-xs leading-relaxed text-muted" role="status">
                {chosen === q.answerIndex ? "Correct. " : "Not quite. "}
                {q.explanation}
              </p>
            )}
          </fieldset>
        );
      })}

      {allAnswered && (
        <div className="card-flat p-4 flex items-center justify-between gap-3" role="status">
          <div>
            <div className="stat-number text-2xl leading-none text-accent">
              {score}/{questions.length}
            </div>
            <p className="text-xs text-muted mt-1.5">
              {completed.has(lessonSlug) ? "Lesson complete — nice work." : "Lesson complete."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAnswers(questions.map(() => null))}
            className="btn-secondary flex items-center gap-2 px-4 py-2.5 text-sm"
          >
            <RotateCcw size={16} strokeWidth={1.8} aria-hidden /> Try again
          </button>
        </div>
      )}
    </section>
  );
}

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LessonQuiz } from "@/components/lesson-quiz";
import { resetLearnProgress } from "@/lib/learn-progress";
import type { QuizQuestion } from "@/lib/education";

beforeEach(() => {
  window.localStorage.clear();
  resetLearnProgress();
});
afterEach(cleanup);

const QUESTIONS: QuizQuestion[] = [
  {
    prompt: "Whiskey is made from?",
    options: ["Grain", "Grapes"],
    answerIndex: 0,
    explanation: "Grain is the defining ingredient.",
  },
  {
    prompt: "US proof is?",
    options: ["Half the ABV", "Double the ABV"],
    answerIndex: 1,
    explanation: "Proof doubles the ABV.",
  },
];

describe("LessonQuiz", () => {
  it("gives instant feedback and locks the question after answering", async () => {
    render(<LessonQuiz lessonSlug="test-lesson" questions={QUESTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: "Grapes" }));
    expect(screen.getByText(/Not quite\. Grain is the defining ingredient\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grain" })).toBeDisabled();
    expect(screen.getByText("1/2 answered")).toBeInTheDocument();
  });

  it("shows the score and marks the lesson complete once all questions are answered", async () => {
    render(<LessonQuiz lessonSlug="test-lesson" questions={QUESTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: "Grain" }));
    await userEvent.click(screen.getByRole("button", { name: "Double the ABV" }));

    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(screen.getByText(/Lesson complete/)).toBeInTheDocument();
    expect(window.localStorage.getItem("whaikey.learn.completed.v1")).toContain("test-lesson");
  });

  it("try again resets answers but keeps the lesson completed", async () => {
    render(<LessonQuiz lessonSlug="test-lesson" questions={QUESTIONS} />);

    await userEvent.click(screen.getByRole("button", { name: "Grain" }));
    await userEvent.click(screen.getByRole("button", { name: "Half the ABV" }));
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));

    expect(screen.getByText("0/2 answered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grain" })).toBeEnabled();
    expect(window.localStorage.getItem("whaikey.learn.completed.v1")).toContain("test-lesson");
  });
});

import type { Metadata } from "next";
import { LearnHub } from "./learn-hub";

export const metadata: Metadata = {
  title: "Whiskey School",
  description: "Short whiskey lessons, quizzes, and a flavor wheel explorer.",
};

export default function LearnPage() {
  return <LearnHub />;
}

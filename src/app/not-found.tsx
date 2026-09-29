import type { Metadata } from "next";
import Link from "next/link";
import { StateScreen } from "@/components/state-screen";

export const metadata: Metadata = { title: "Not found" };

/**
 * Every unmatched URL and every `notFound()` without a closer boundary
 * (review REL-6.2). Branded and inside the shell, so the header's back and
 * the nav still work — Next's default 404 had neither.
 */
export default function NotFound() {
  return (
    <StateScreen
      emoji="🥃"
      title="Nothing poured here"
      action={
        <Link href="/" className="btn-primary px-8 py-3">
          Back to Home
        </Link>
      }
    >
      This page doesn&apos;t exist, or it isn&apos;t shared with you.
    </StateScreen>
  );
}

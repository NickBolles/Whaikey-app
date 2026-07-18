import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { isAiConfigured } from "@/lib/ai/client";
import { ChatClient } from "./chat-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Concierge — Whaikey" };

export default async function ChatPage() {
  const user = await getSessionUser();

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70dvh] px-6 text-center gap-6">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🥃
        </div>
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            The concierge is members-only
          </h1>
          <p className="text-muted mt-3 max-w-sm leading-relaxed">
            Sign in to ask about your bar, get pour suggestions, and explore the whiskey world.
          </p>
        </div>
        <Link href="/sign-in" className="btn-primary px-10 py-3.5 text-base">
          Sign in
        </Link>
      </div>
    );
  }

  return <ChatClient aiConfigured={isAiConfigured()} />;
}

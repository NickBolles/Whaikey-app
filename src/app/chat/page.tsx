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
      <div className="flex flex-col items-center justify-center min-h-[70dvh] px-6 text-center gap-4">
        <div className="text-5xl">🥃</div>
        <h1 className="text-2xl font-bold">The concierge is members-only</h1>
        <p className="text-muted max-w-sm">
          Sign in to ask about your bar, get pour suggestions, and explore the whiskey world.
        </p>
        <Link
          href="/sign-in"
          className="rounded-xl bg-accent text-background font-semibold px-8 py-3 hover:bg-accent-deep transition-colors"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return <ChatClient aiConfigured={isAiConfigured()} />;
}

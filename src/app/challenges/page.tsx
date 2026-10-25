import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { BOARD_KEYS, getBoard, listChallenges, listCrests, type BoardKey } from "@/lib/challenges";
import { unreadCount } from "@/lib/notify";
import { appNow } from "@/lib/clock";
import { SocialTabs } from "@/components/social/social-tabs";
import { BoardOptIn, JoinChallengeButton } from "@/components/social/challenge-client";

export const dynamic = "force-dynamic";

const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Challenges and the friend board (docs/SOCIAL.md §7.12–7.13; design board
 * C6/C7). Every number here is a count of DIFFERENT things met, capped at the
 * goal — a repeat counts for nothing and there is no way to win by more.
 */
export default async function ChallengesPage({ searchParams }: { searchParams: Promise<{ board?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in?next=/challenges");
  const { board: boardParam } = await searchParams;
  const key: BoardKey = (BOARD_KEYS as readonly string[]).includes(boardParam ?? "") ? (boardParam as BoardKey) : "regions";
  const db = getDb();
  const now = appNow();
  const [cards, crests, board, unread] = await Promise.all([
    listChallenges(db, user.id, now),
    listCrests(db, user.id),
    getBoard(db, user.id, key, now),
    unreadCount(db, user.id),
  ]);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-3 pb-24 pt-5">
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight">Friends</h1>
        <SocialTabs unread={unread} />
      </header>

      <section aria-labelledby="ch-heading" className="flex flex-col gap-2">
        <h2 id="ch-heading" className="section-label">
          This month
        </h2>
        <ul className="flex flex-col gap-2">
          {cards.map((c) => {
            const pct = Math.round((c.progress.count / c.progress.target) * 100);
            return (
              <li key={c.slug} id={c.slug} className="card flex scroll-mt-20 flex-col gap-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-display text-base font-semibold leading-tight">
                      {c.completedAt && <span aria-label="Crest earned">🏅 </span>}
                      {c.title}
                    </p>
                    <p className="text-xs text-muted">
                      {c.description} {c.clubName ? `· ${c.clubName} · ` : "· "}until {fmtDay(c.endsAt)}
                    </p>
                  </div>
                  <JoinChallengeButton slug={c.slug} joined={c.joined} completed={!!c.completedAt} />
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-raised" aria-hidden>
                    <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs tabular-nums text-muted">
                    {c.progress.count} of {c.progress.target}
                  </span>
                </div>
                {c.friends.length > 0 && (
                  <p className="text-xs text-muted">
                    {c.friends.map((f) => `@${f.handle} ${f.completed ? "✓" : `${f.count}/${c.progress.target}`}`).join(" · ")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="board-heading" className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 id="board-heading" className="section-label">
            Friend board
          </h2>
          <BoardOptIn optedIn={board.state !== "not_opted_in"} />
        </div>
        {board.state === "not_opted_in" && (
          <p className="text-sm text-muted">
            Opt in to compare how widely you and your friends explore this season — different regions, distilleries or
            descriptors in shared notes. Never how much. It appears once 3 friends have joined.
          </p>
        )}
        {board.state === "too_few" && (
          <p className="text-sm text-muted">
            You&rsquo;re in. {board.optedInFriends} of {board.needed} friends have joined — the board appears at {board.needed}.
          </p>
        )}
        {board.state === "ready" && (
          <div className="card-flat flex flex-col gap-2 p-3">
            <nav aria-label="Board by" className="flex gap-1 text-xs">
              {BOARD_KEYS.map((k) => (
                <Link
                  key={k}
                  href={`/challenges?board=${k}`}
                  aria-current={k === board.key ? "page" : undefined}
                  className={`rounded-lg px-2.5 py-1 ${k === board.key ? "bg-surface-raised text-foreground" : "text-muted"}`}
                >
                  {k[0].toUpperCase() + k.slice(1)}
                </Link>
              ))}
              <span className="ml-auto self-center text-muted">{board.season}</span>
            </nav>
            <ol className="flex flex-col">
              {board.rows.map((r) => (
                <li key={r.handle} className={`flex items-center gap-3 py-1 text-sm ${r.you ? "font-medium" : ""}`}>
                  <span className="w-10 text-xs tabular-nums text-muted">{r.tied ? `=${r.rank}` : r.rank}</span>
                  <span className="min-w-0 flex-1 truncate">{r.you ? "You" : `@${r.handle}`}</span>
                  <span className="tabular-nums">{r.count}</span>
                </li>
              ))}
            </ol>
            <p className="text-[11px] text-muted">Counted from notes you share, different {board.key} this season. Ties are ties.</p>
          </div>
        )}
      </section>

      {crests.length > 0 && (
        <section aria-labelledby="crests-heading" className="flex flex-col gap-2">
          <h2 id="crests-heading" className="section-label">
            Your crests
          </h2>
          <ul className="flex flex-wrap gap-1.5">
            {crests.map((c) => (
              <li key={c.slug} className="chip px-2.5 py-1 text-xs">
                🏅 {c.title}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

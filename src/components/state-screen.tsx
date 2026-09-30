/**
 * A whole-page empty state (DESIGN.md rule 6: an emoji or icon, one serif
 * line, one muted line, one clear action) for the not-found and error
 * boundaries. Sits inside the app shell, so the header's back button and the
 * bottom nav stay available as the other ways out.
 */
export function StateScreen({
  emoji,
  title,
  children,
  action,
  headingLevel = 1,
}: {
  emoji: string;
  title: string;
  children: React.ReactNode;
  action: React.ReactNode;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
      <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
        {emoji}
      </div>
      <div>
        <Heading className="font-display text-2xl font-semibold">{title}</Heading>
        <p className="mx-auto mt-2 max-w-sm leading-relaxed text-muted">{children}</p>
      </div>
      {action}
    </div>
  );
}

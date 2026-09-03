/**
 * The update gate (docs/NATIVE_APP.md §2.2, docs/STORYBOARD.md §3.15).
 *
 * Shown when the installed shell is older than the deployed site needs — which
 * is also what an operator sees after raising the floor to stop a bad deploy.
 * It is the last screen a broken release still renders, so it says the one
 * useful thing and offers the one useful action, and nothing else: no nav, no
 * header, nothing to tap that leads back into a UI the binary cannot run.
 *
 * A plain component rather than JSX inlined in the shell, so `/app-update`
 * can render exactly this and the visual suite has something deterministic to
 * screenshot on a screen nobody can reach on purpose.
 */
export function ShellUpdateRequired({
  notice,
  storeUrl,
  installed,
  required,
}: {
  notice?: string | null;
  storeUrl?: string | null;
  installed?: string | null;
  required?: string | null;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Update Whaikey"
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-5 bg-background px-8 text-center"
    >
      <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
        🥃
      </div>
      <h1 className="font-display text-2xl font-semibold">Update Whaikey</h1>
      <p className="text-muted max-w-sm leading-relaxed">
        {notice ??
          "This version of the app is too old for what's on the shelf. Updating takes a moment, and nothing you've logged is lost."}
      </p>
      {storeUrl && (
        <a href={storeUrl} className="btn-primary px-8 py-3">
          Get the update
        </a>
      )}
      {installed && required && (
        <p className="text-xs text-muted/70">
          Installed {installed} · needs {required}
        </p>
      )}
    </div>
  );
}

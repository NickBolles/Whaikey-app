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
  androidStoreUrl,
  installed,
  required,
}: {
  notice?: string | null;
  /** The store for this platform — or, on `/app-update`, the iOS one. */
  storeUrl?: string | null;
  /**
   * Only `/app-update` passes this: a page reachable from anywhere has no
   * platform to infer, so it offers both rather than sending half its visitors
   * to the wrong store. The shell knows which device it is on and passes one.
   */
  androidStoreUrl?: string | null;
  installed?: string | null;
  required?: string | null;
}) {
  const both = Boolean(storeUrl && androidStoreUrl);
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Update Whaikey"
      // Above everything, including the nav's quick-actions sheet at z-[60] —
      // which is the later DOM sibling and would otherwise paint over this and
      // offer routes into a UI the binary cannot run.
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 bg-background px-8 text-center"
    >
      <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
        🥃
      </div>
      <h1 className="font-display text-2xl font-semibold">Update Whaikey</h1>
      <p className="text-muted max-w-sm leading-relaxed">
        {notice ??
          "This version of the app is too old for what's on the shelf. Updating takes a moment, and nothing you've logged is lost."}
      </p>
      {(storeUrl || androidStoreUrl) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {storeUrl && (
            <a href={storeUrl} className="btn-primary px-8 py-3">
              {both ? "App Store" : "Get the update"}
            </a>
          )}
          {androidStoreUrl && (
            <a
              href={androidStoreUrl}
              className={both ? "btn-secondary px-8 py-3" : "btn-primary px-8 py-3"}
            >
              {both ? "Google Play" : "Get the update"}
            </a>
          )}
        </div>
      )}
      {installed && required && (
        <p className="text-xs text-muted/70">
          Installed {installed} · needs {required}
        </p>
      )}
    </div>
  );
}

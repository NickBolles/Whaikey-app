/**
 * The only return target a sign-in flow will honor — shared by the native
 * exchange redirect (server) and the web OAuth callbackURL (client), so the
 * two validators can never drift apart.
 *
 * Accepts a same-origin relative path with a single leading slash. Anything
 * else — absolute URLs, protocol-relative "//host", backslash variants like
 * "/\evil.example" (WHATWG URL parsing treats "\" as "/"), or C0
 * controls/DEL like "/\t/evil.example" (WHATWG strips tab/CR/LF, collapsing
 * it to protocol-relative) — would turn the post-sign-in redirect into an
 * open redirect and collapses to null (callers fall back to "/").
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || !/^\/(?!\/)/.test(raw) || raw.includes("\\")) return null;
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  return raw;
}

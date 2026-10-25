/**
 * The guest seat cookie (D20). One per flight, named by the join code so a
 * guest at two tables in one night holds two independent seats. httpOnly so
 * page script never sees the bearer token; 24 h, like the seat itself.
 */
export const guestCookieName = (joinCode: string) => `whaikey_guest_${joinCode}`;

export function readGuestTokenFromHeader(cookieHeader: string | null, joinCode: string): string | null {
  if (!cookieHeader) return null;
  const name = guestCookieName(joinCode);
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export const guestCookieOptions = (expires: Date) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  expires,
});

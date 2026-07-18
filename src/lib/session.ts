import { headers } from "next/headers";
import { NextResponse } from "next/server";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

/**
 * Resolve the signed-in user, or null. All server code goes through this
 * (never through auth.api directly) so tests can mock a single seam.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const { auth } = await import("@/lib/auth");
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  const { id, name, email, image } = session.user;
  return { id, name, email, image };
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** For API routes: returns the user or throws UnauthorizedError. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/**
 * Wrap an API handler body: converts UnauthorizedError into a 401 response
 * and unexpected errors into a 500 (with logging).
 */
export async function withErrorHandling<T>(fn: () => Promise<T>): Promise<T | NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error(err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

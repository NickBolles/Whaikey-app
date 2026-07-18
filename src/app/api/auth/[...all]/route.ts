import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

// Node runtime (not edge): Better Auth talks to the DB driver.
export const runtime = "nodejs";

export const { GET, POST } = toNextJsHandler(auth);

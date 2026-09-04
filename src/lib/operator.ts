import type { SessionUser } from "@/lib/session";

/**
 * Who may work the moderation queue (PLAN.md §9.4).
 *
 * An env allowlist, explicitly "at first" in the plan. It is the smallest
 * thing that is actually a control: no role column to get out of sync, no
 * self-service path to becoming one, and changing the set is a deploy — which
 * for a one-operator product is the right trade. It becomes a real role when
 * there is more than one person and a reason to grant access without a deploy.
 *
 * Ids, not emails: an email is a claim the identity provider can change, and
 * the user id is what every other table already keys on.
 */
export function operatorIds(): Set<string> {
  return new Set(
    (process.env.WHAIKEY_OPERATOR_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isOperator(user: Pick<SessionUser, "id"> | null | undefined): boolean {
  if (!user) return false;
  const ids = operatorIds();
  // An empty allowlist grants nobody. A deploy that forgets the variable gets
  // a queue no one can open, which is the failure worth having.
  return ids.size > 0 && ids.has(user.id);
}

export class NotAnOperatorError extends Error {
  constructor() {
    super("Operator access required");
    this.name = "NotAnOperatorError";
  }
}

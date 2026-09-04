import { eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { feedback, user as userTable } from "@/db/schema";

/**
 * The support inbox (PLAN.md §9.7).
 *
 * Storing feedback rather than mailing it only helps if somebody works it, so
 * this is a queue and not a list: `handledAt` is what says a message is dealt
 * with, and the ordering is what puts the undealt-with ones in front of the
 * operator.
 */
export interface FeedbackRow {
  id: string;
  body: string;
  contact: string | null;
  platform: string | null;
  appVersion: string | null;
  handledAt: Date | null;
  createdAt: Date;
  senderName: string | null;
  senderEmail: string | null;
}

export async function listFeedback(db: DB, limit = 100): Promise<FeedbackRow[]> {
  return db
    .select({
      id: feedback.id,
      body: feedback.body,
      contact: feedback.contact,
      platform: feedback.platform,
      appVersion: feedback.appVersion,
      handledAt: feedback.handledAt,
      createdAt: feedback.createdAt,
      senderName: userTable.name,
      senderEmail: userTable.email,
    })
    .from(feedback)
    .leftJoin(userTable, eq(userTable.id, feedback.userId))
    // Outstanding first, and oldest-first within it for the same reason the
    // report queue is oldest-first: whatever has waited longest is otherwise
    // the thing nobody reaches. Handled rows are history, so they read
    // newest-first underneath.
    .orderBy(
      sql`${feedback.handledAt} is not null`,
      sql`case when ${feedback.handledAt} is null then ${feedback.createdAt} end asc nulls last`,
      sql`${feedback.createdAt} desc`,
    )
    .limit(limit);
}

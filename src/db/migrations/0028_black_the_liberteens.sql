ALTER TABLE "bottle_submissions" DROP CONSTRAINT "bottle_submissions_reviewed_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "bottles" DROP CONSTRAINT "bottles_submitted_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "moderation_actions" DROP CONSTRAINT "moderation_actions_actor_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "moderation_actions" ALTER COLUMN "actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "subject_snapshot" text;--> statement-breakpoint
ALTER TABLE "bottle_submissions" ADD CONSTRAINT "bottle_submissions_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottles" ADD CONSTRAINT "bottles_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
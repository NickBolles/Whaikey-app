ALTER TABLE "moderation_actions" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "moderation_actions_seq_idx" ON "moderation_actions" USING btree ("seq");
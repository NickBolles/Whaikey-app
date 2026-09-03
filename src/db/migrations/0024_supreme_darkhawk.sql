CREATE TABLE "bottle_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"bottle_id" text NOT NULL,
	"submitted_by" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"distillery_text" text,
	"upc" text,
	"source" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"duplicate_of_bottle_id" text,
	"review_note" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bottle_submissions" ADD CONSTRAINT "bottle_submissions_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottle_submissions" ADD CONSTRAINT "bottle_submissions_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottle_submissions" ADD CONSTRAINT "bottle_submissions_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottle_submissions" ADD CONSTRAINT "bottle_submissions_duplicate_of_bottle_id_bottles_id_fk" FOREIGN KEY ("duplicate_of_bottle_id") REFERENCES "public"."bottles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bottle_submissions_bottle_uq" ON "bottle_submissions" USING btree ("bottle_id");--> statement-breakpoint
CREATE INDEX "bottle_submissions_state_idx" ON "bottle_submissions" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "bottle_submissions_user_idx" ON "bottle_submissions" USING btree ("submitted_by","created_at");
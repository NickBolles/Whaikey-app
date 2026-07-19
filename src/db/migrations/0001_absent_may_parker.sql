CREATE TABLE "rec_explanations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bottle_id" text NOT NULL,
	"mode" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "palate_profile" jsonb;--> statement-breakpoint
ALTER TABLE "rec_explanations" ADD CONSTRAINT "rec_explanations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rec_explanations" ADD CONSTRAINT "rec_explanations_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rec_explanations_user_bottle_mode_uq" ON "rec_explanations" USING btree ("user_id","bottle_id","mode");--> statement-breakpoint
CREATE INDEX "rec_explanations_user_idx" ON "rec_explanations" USING btree ("user_id");
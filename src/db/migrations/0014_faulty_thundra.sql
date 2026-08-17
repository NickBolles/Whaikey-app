CREATE TABLE "critic_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"bottle_id" text NOT NULL,
	"publication" text NOT NULL,
	"score" text,
	"score_scale" text,
	"note" text NOT NULL,
	"flavor_tags" jsonb,
	"source_url" text NOT NULL,
	"retrieved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "critic_notes" ADD CONSTRAINT "critic_notes_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "critic_notes_bottle_idx" ON "critic_notes" USING btree ("bottle_id");
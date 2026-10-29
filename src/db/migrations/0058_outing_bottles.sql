CREATE TABLE "outing_bottles" (
	"id" text PRIMARY KEY NOT NULL,
	"outing_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"bottle_id" text,
	"label" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outing_bottles" ADD CONSTRAINT "outing_bottles_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_bottles" ADD CONSTRAINT "outing_bottles_participant_id_outing_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."outing_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_bottles" ADD CONSTRAINT "outing_bottles_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outing_bottles_outing_key_uq" ON "outing_bottles" USING btree ("outing_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "outing_bottles_participant_idx" ON "outing_bottles" USING btree ("participant_id");
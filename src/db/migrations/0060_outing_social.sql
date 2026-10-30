CREATE TABLE "outing_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"outing_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"body" text NOT NULL,
	"mentions" jsonb,
	"edited_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outing_reactions" (
	"id" text PRIMARY KEY NOT NULL,
	"outing_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outing_comments" ADD CONSTRAINT "outing_comments_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_comments" ADD CONSTRAINT "outing_comments_participant_id_outing_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."outing_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_reactions" ADD CONSTRAINT "outing_reactions_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_reactions" ADD CONSTRAINT "outing_reactions_participant_id_outing_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."outing_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outing_comments_outing_idx" ON "outing_comments" USING btree ("outing_id");--> statement-breakpoint
CREATE INDEX "outing_comments_participant_idx" ON "outing_comments" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outing_reactions_one_uq" ON "outing_reactions" USING btree ("participant_id","target_kind","target_id","kind");--> statement-breakpoint
CREATE INDEX "outing_reactions_outing_idx" ON "outing_reactions" USING btree ("outing_id");
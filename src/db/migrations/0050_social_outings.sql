CREATE TABLE "outing_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"outing_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"body" text NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outing_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"outing_id" text NOT NULL,
	"user_id" text,
	"guest_token_hash" text,
	"guest_name" text,
	"joined_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "outing_participants_guest_token_hash_unique" UNIQUE("guest_token_hash")
);
--> statement-breakpoint
CREATE TABLE "outing_tastings" (
	"id" text PRIMARY KEY NOT NULL,
	"outing_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"bottle_id" text,
	"label" text NOT NULL,
	"rating" double precision,
	"flavor_tags" jsonb,
	"note" text,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outings" (
	"id" text PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL,
	"club_id" text,
	"title" text NOT NULL,
	"distillery_name" text NOT NULL,
	"distillery_id" text,
	"location" text,
	"visit_on" text NOT NULL,
	"ride_reminder" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"join_code" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "outings_join_code_unique" UNIQUE("join_code")
);
--> statement-breakpoint
ALTER TABLE "outing_notes" ADD CONSTRAINT "outing_notes_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_notes" ADD CONSTRAINT "outing_notes_participant_id_outing_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."outing_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_participants" ADD CONSTRAINT "outing_participants_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_participants" ADD CONSTRAINT "outing_participants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_tastings" ADD CONSTRAINT "outing_tastings_outing_id_outings_id_fk" FOREIGN KEY ("outing_id") REFERENCES "public"."outings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_tastings" ADD CONSTRAINT "outing_tastings_participant_id_outing_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."outing_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outing_tastings" ADD CONSTRAINT "outing_tastings_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outings" ADD CONSTRAINT "outings_host_id_user_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outings" ADD CONSTRAINT "outings_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outings" ADD CONSTRAINT "outings_distillery_id_distilleries_id_fk" FOREIGN KEY ("distillery_id") REFERENCES "public"."distilleries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outing_notes_outing_idx" ON "outing_notes" USING btree ("outing_id");--> statement-breakpoint
CREATE INDEX "outing_notes_participant_idx" ON "outing_notes" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outing_participants_outing_user_uq" ON "outing_participants" USING btree ("outing_id","user_id");--> statement-breakpoint
CREATE INDEX "outing_participants_user_idx" ON "outing_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outing_participants_expires_idx" ON "outing_participants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outing_tastings_outing_idx" ON "outing_tastings" USING btree ("outing_id");--> statement-breakpoint
CREATE INDEX "outing_tastings_participant_idx" ON "outing_tastings" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "outings_host_idx" ON "outings" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "outings_club_idx" ON "outings" USING btree ("club_id");
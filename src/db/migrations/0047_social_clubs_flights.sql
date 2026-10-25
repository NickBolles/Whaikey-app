CREATE TABLE "club_invites" (
	"code" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"uses" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_members" (
	"club_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	CONSTRAINT "club_members_club_id_user_id_pk" PRIMARY KEY("club_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flight_bottles" (
	"flight_id" text NOT NULL,
	"slot" text NOT NULL,
	"bottle_id" text NOT NULL,
	CONSTRAINT "flight_bottles_flight_id_slot_pk" PRIMARY KEY("flight_id","slot")
);
--> statement-breakpoint
CREATE TABLE "flight_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"flight_id" text NOT NULL,
	"slot" text NOT NULL,
	"rating" double precision,
	"flavor_tags" jsonb,
	"note" text,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flight_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"flight_id" text NOT NULL,
	"user_id" text,
	"guest_token_hash" text,
	"guest_name" text,
	"joined_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "flight_participants_guest_token_hash_unique" UNIQUE("guest_token_hash")
);
--> statement-breakpoint
CREATE TABLE "flights" (
	"id" text PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL,
	"club_id" text,
	"title" text NOT NULL,
	"blind" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"join_code" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"revealed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "flights_join_code_unique" UNIQUE("join_code")
);
--> statement-breakpoint
ALTER TABLE "club_invites" ADD CONSTRAINT "club_invites_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_invites" ADD CONSTRAINT "club_invites_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_bottles" ADD CONSTRAINT "flight_bottles_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_bottles" ADD CONSTRAINT "flight_bottles_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_entries" ADD CONSTRAINT "flight_entries_participant_id_flight_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."flight_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_entries" ADD CONSTRAINT "flight_entries_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_participants" ADD CONSTRAINT "flight_participants_flight_id_flights_id_fk" FOREIGN KEY ("flight_id") REFERENCES "public"."flights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_participants" ADD CONSTRAINT "flight_participants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flights" ADD CONSTRAINT "flights_host_id_user_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flights" ADD CONSTRAINT "flights_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_invites_club_idx" ON "club_invites" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "club_members_user_idx" ON "club_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flight_entries_participant_slot_uq" ON "flight_entries" USING btree ("participant_id","slot");--> statement-breakpoint
CREATE INDEX "flight_entries_flight_idx" ON "flight_entries" USING btree ("flight_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flight_participants_flight_user_uq" ON "flight_participants" USING btree ("flight_id","user_id");--> statement-breakpoint
CREATE INDEX "flight_participants_user_idx" ON "flight_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "flight_participants_expires_idx" ON "flight_participants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "flights_host_idx" ON "flights" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "flights_club_idx" ON "flights" USING btree ("club_id");
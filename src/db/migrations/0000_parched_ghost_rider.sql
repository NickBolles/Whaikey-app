CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bottle_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"bottle_id" text NOT NULL,
	"alias" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bottles" (
	"id" text PRIMARY KEY NOT NULL,
	"distillery_id" text,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"region" text,
	"age_years" integer,
	"abv" double precision,
	"cask_types" jsonb,
	"mash_bill" text,
	"msrp" double precision,
	"avg_price" double precision,
	"description" text,
	"flavor_profile" jsonb,
	"image_url" text,
	"status" text DEFAULT 'verified' NOT NULL,
	"submitted_by" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distilleries" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"region" text,
	"founded" integer,
	"description" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pairings" (
	"id" text PRIMARY KEY NOT NULL,
	"bottle_id" text NOT NULL,
	"pairing_type" text NOT NULL,
	"suggestion" text NOT NULL,
	"rationale" text,
	"source" text DEFAULT 'ai' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pours" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bottle_id" text NOT NULL,
	"user_bottle_id" text,
	"rating" double precision,
	"serving_style" text,
	"amount_ml" integer,
	"context" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" text PRIMARY KEY NOT NULL,
	"bottle_id" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"price" double precision NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "tasting_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"pour_id" text NOT NULL,
	"nose" text,
	"palate" text,
	"finish" text,
	"freeform" text,
	"flavor_tags" jsonb,
	"extracted_by" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tasting_notes_pour_id_unique" UNIQUE("pour_id")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_bottles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bottle_id" text NOT NULL,
	"relationship" text NOT NULL,
	"status" text,
	"fill_level" integer,
	"quantity" integer DEFAULT 1 NOT NULL,
	"purchase_price" double precision,
	"purchase_date" timestamp with time zone,
	"store" text,
	"est_value" double precision,
	"location" text,
	"notes" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottle_aliases" ADD CONSTRAINT "bottle_aliases_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottles" ADD CONSTRAINT "bottles_distillery_id_distilleries_id_fk" FOREIGN KEY ("distillery_id") REFERENCES "public"."distilleries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottles" ADD CONSTRAINT "bottles_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairings" ADD CONSTRAINT "pairings_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pours" ADD CONSTRAINT "pours_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pours" ADD CONSTRAINT "pours_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pours" ADD CONSTRAINT "pours_user_bottle_id_user_bottles_id_fk" FOREIGN KEY ("user_bottle_id") REFERENCES "public"."user_bottles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasting_notes" ADD CONSTRAINT "tasting_notes_pour_id_pours_id_fk" FOREIGN KEY ("pour_id") REFERENCES "public"."pours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bottles" ADD CONSTRAINT "user_bottles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_bottles" ADD CONSTRAINT "user_bottles_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bottle_aliases_bottle_idx" ON "bottle_aliases" USING btree ("bottle_id");--> statement-breakpoint
CREATE INDEX "bottle_aliases_alias_idx" ON "bottle_aliases" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "bottles_category_idx" ON "bottles" USING btree ("category");--> statement-breakpoint
CREATE INDEX "bottles_name_idx" ON "bottles" USING btree ("name");--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_user_idx" ON "chat_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pairings_bottle_idx" ON "pairings" USING btree ("bottle_id");--> statement-breakpoint
CREATE INDEX "pours_user_idx" ON "pours" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pours_bottle_idx" ON "pours" USING btree ("bottle_id");--> statement-breakpoint
CREATE INDEX "price_history_bottle_idx" ON "price_history" USING btree ("bottle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_bottles_user_bottle_uq" ON "user_bottles" USING btree ("user_id","bottle_id");--> statement-breakpoint
CREATE INDEX "user_bottles_user_idx" ON "user_bottles" USING btree ("user_id");
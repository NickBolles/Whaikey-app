CREATE TABLE "auth_provider_events" (
	"id" text PRIMARY KEY NOT NULL,
	"jti" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"user_id" text,
	"event_type" text NOT NULL,
	"event_time" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_provider_events_jti_unique" UNIQUE("jti")
);
--> statement-breakpoint
ALTER TABLE "auth_provider_events" ADD CONSTRAINT "auth_provider_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_provider_events_user_idx" ON "auth_provider_events" USING btree ("user_id");
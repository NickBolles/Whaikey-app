CREATE TABLE "phone_lookups" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "phone_hash" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "phone_last2" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "phone_discoverable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_lookups" ADD CONSTRAINT "phone_lookups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_lookups_user_idx" ON "phone_lookups" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_phone_hash_unique" UNIQUE("phone_hash");
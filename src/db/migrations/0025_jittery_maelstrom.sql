CREATE TABLE "age_verifications" (
	"user_id" text PRIMARY KEY NOT NULL,
	"birth_date" text NOT NULL,
	"market" text NOT NULL,
	"minimum_age" integer NOT NULL,
	"passed" boolean NOT NULL,
	"eligible_on" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "age_verifications" ADD CONSTRAINT "age_verifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
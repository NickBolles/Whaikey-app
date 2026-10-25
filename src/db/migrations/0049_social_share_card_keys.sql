CREATE TABLE "share_card_keys" (
	"user_id" text PRIMARY KEY NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_card_keys" ADD CONSTRAINT "share_card_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
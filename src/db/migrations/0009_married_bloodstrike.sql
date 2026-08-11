CREATE TABLE "pour_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"pour_id" text NOT NULL,
	"user_id" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pour_shares_pour_id_unique" UNIQUE("pour_id"),
	CONSTRAINT "pour_shares_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "pour_shares" ADD CONSTRAINT "pour_shares_pour_id_pours_id_fk" FOREIGN KEY ("pour_id") REFERENCES "public"."pours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pour_shares" ADD CONSTRAINT "pour_shares_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pour_shares_user_idx" ON "pour_shares" USING btree ("user_id");
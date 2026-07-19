CREATE TABLE "bottle_upcs" (
	"id" text PRIMARY KEY NOT NULL,
	"upc" text NOT NULL,
	"bottle_id" text NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"confirmed_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bottle_upcs" ADD CONSTRAINT "bottle_upcs_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bottle_upcs_upc_bottle_uq" ON "bottle_upcs" USING btree ("upc","bottle_id");--> statement-breakpoint
CREATE INDEX "bottle_upcs_upc_idx" ON "bottle_upcs" USING btree ("upc");
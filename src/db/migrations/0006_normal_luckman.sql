CREATE TABLE "bottle_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"bottle_id" text NOT NULL,
	"url" text NOT NULL,
	"label" text,
	"retailer_sku" text,
	"retrieved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bottle_verifications" ADD CONSTRAINT "bottle_verifications_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bottle_verifications_bottle_idx" ON "bottle_verifications" USING btree ("bottle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bottle_verifications_bottle_url_uq" ON "bottle_verifications" USING btree ("bottle_id","url");
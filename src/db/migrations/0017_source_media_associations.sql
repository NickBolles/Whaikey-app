DROP INDEX "bottle_media_bottle_url_uq";--> statement-breakpoint
ALTER TABLE "bottle_verifications" ADD COLUMN "promoted_bottle" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bottle_media_resource_url_uq" ON "bottle_media" USING btree ("resource_id","url");
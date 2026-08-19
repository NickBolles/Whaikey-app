ALTER TABLE "bottle_claims" ADD COLUMN "canonicalized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bottle_media" ADD COLUMN "canonicalized" boolean DEFAULT false NOT NULL;
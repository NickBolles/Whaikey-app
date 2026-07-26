ALTER TABLE "bottles" ADD COLUMN "producer_flavor_source_url" text;--> statement-breakpoint
ALTER TABLE "bottles" ADD COLUMN "producer_flavor_source_label" text;--> statement-breakpoint
ALTER TABLE "bottles" ADD COLUMN "producer_flavor_retrieved_at" timestamp with time zone;
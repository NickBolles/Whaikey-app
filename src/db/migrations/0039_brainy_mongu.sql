ALTER TABLE "ai_usage" ADD COLUMN "web_search_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "web_fetch_requests" integer DEFAULT 0 NOT NULL;
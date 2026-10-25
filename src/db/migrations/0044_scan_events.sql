CREATE TABLE "scan_events" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"source" text NOT NULL,
	"upc" text,
	"result_count" integer DEFAULT 0 NOT NULL,
	"confirm_rank" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scan_events_created_idx" ON "scan_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "scan_events_upc_idx" ON "scan_events" USING btree ("upc");
CREATE TABLE "bottle_enrichment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"step" text,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bottle_enrichment_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"bottle_id" text NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"steps_done" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"waiting_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb,
	"error" text,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrichment_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text,
	"run_id" text,
	"step" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"bottles" integer DEFAULT 1 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"web_searches" integer DEFAULT 0 NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"tiers" jsonb NOT NULL,
	"state" text NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stop_reason" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrichment_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"daily_budget_usd" double precision DEFAULT 2 NOT NULL,
	"missing_cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bottle_enrichment_events" ADD CONSTRAINT "bottle_enrichment_events_job_id_bottle_enrichment_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."bottle_enrichment_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottle_enrichment_jobs" ADD CONSTRAINT "bottle_enrichment_jobs_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_calls" ADD CONSTRAINT "enrichment_calls_job_id_bottle_enrichment_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."bottle_enrichment_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_calls" ADD CONSTRAINT "enrichment_calls_run_id_enrichment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enrichment_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bottle_enrichment_events_job_seq_uq" ON "bottle_enrichment_events" USING btree ("job_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "bottle_enrichment_jobs_bottle_uq" ON "bottle_enrichment_jobs" USING btree ("bottle_id");--> statement-breakpoint
CREATE INDEX "bottle_enrichment_jobs_state_idx" ON "bottle_enrichment_jobs" USING btree ("state","not_before");--> statement-breakpoint
CREATE INDEX "enrichment_calls_created_idx" ON "enrichment_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "enrichment_calls_run_idx" ON "enrichment_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "enrichment_runs_started_idx" ON "enrichment_runs" USING btree ("started_at");
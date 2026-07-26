CREATE TABLE "catalog_verification_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"bottle_id" text NOT NULL,
	"lease_token" text NOT NULL,
	"worker" text NOT NULL,
	"partition" integer NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"evidence" jsonb,
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_verification_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"requested_model" text NOT NULL,
	"resolved_model" text NOT NULL,
	"workers" integer NOT NULL,
	"batch_size" integer NOT NULL,
	"limit_count" integer NOT NULL,
	"partitions" integer DEFAULT 1 NOT NULL,
	"config" jsonb,
	"summary" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_verification_work" (
	"bottle_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_eligible_at" timestamp with time zone NOT NULL,
	"lease_token" text,
	"lease_worker" text,
	"lease_run_id" text,
	"lease_expires_at" timestamp with time zone,
	"last_outcome" text,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_verification_attempts" ADD CONSTRAINT "catalog_verification_attempts_run_id_catalog_verification_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."catalog_verification_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_verification_attempts" ADD CONSTRAINT "catalog_verification_attempts_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_verification_work" ADD CONSTRAINT "catalog_verification_work_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_verification_work" ADD CONSTRAINT "catalog_verification_work_lease_run_id_catalog_verification_runs_id_fk" FOREIGN KEY ("lease_run_id") REFERENCES "public"."catalog_verification_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_verification_attempts_run_idx" ON "catalog_verification_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "catalog_verification_attempts_bottle_idx" ON "catalog_verification_attempts" USING btree ("bottle_id");--> statement-breakpoint
CREATE INDEX "catalog_verification_runs_status_idx" ON "catalog_verification_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "catalog_verification_work_claim_idx" ON "catalog_verification_work" USING btree ("status","priority","next_eligible_at");--> statement-breakpoint
CREATE INDEX "catalog_verification_work_lease_run_idx" ON "catalog_verification_work" USING btree ("lease_run_id");
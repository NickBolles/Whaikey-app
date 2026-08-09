CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text,
	"device_label" text,
	"device_platform" text,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"categories" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quiet_hours_enabled" boolean DEFAULT false NOT NULL,
	"quiet_start" text DEFAULT '22:00' NOT NULL,
	"quiet_end" text DEFAULT '08:00' NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "p256dh" text;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "auth_secret" text;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "category_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "quiet_hours_mode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "quiet_start" text;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "quiet_end" text;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "last_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "last_failure_reason" text;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_device_id_push_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."push_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_idx" ON "notification_deliveries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_device_idx" ON "notification_deliveries" USING btree ("device_id");
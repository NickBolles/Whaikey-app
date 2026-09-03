CREATE TABLE "native_auth_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"code_challenge" text NOT NULL,
	"state" text NOT NULL,
	"next" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "native_auth_requests_expires_idx" ON "native_auth_requests" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "native_auth_codes" DROP COLUMN "used_at";
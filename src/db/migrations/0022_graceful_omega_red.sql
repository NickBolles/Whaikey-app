ALTER TABLE "pours" ADD COLUMN "client_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "pours_user_client_idx" ON "pours" USING btree ("user_id","client_id");
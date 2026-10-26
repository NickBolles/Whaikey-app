CREATE TABLE "pour_tags" (
	"pour_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pour_tags_pour_id_tag_id_pk" PRIMARY KEY("pour_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pour_tags" ADD CONSTRAINT "pour_tags_pour_id_pours_id_fk" FOREIGN KEY ("pour_id") REFERENCES "public"."pours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pour_tags" ADD CONSTRAINT "pour_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pour_tags" ADD CONSTRAINT "pour_tags_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pour_tags_tag_idx" ON "pour_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "pour_tags_user_idx" ON "pour_tags" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_user_key_idx" ON "tags" USING btree ("user_id","key");
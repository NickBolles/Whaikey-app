CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bottle_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`bottle_id` text NOT NULL,
	`alias` text NOT NULL,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bottle_aliases_bottle_idx` ON `bottle_aliases` (`bottle_id`);--> statement-breakpoint
CREATE INDEX `bottle_aliases_alias_idx` ON `bottle_aliases` (`alias`);--> statement-breakpoint
CREATE TABLE `bottles` (
	`id` text PRIMARY KEY NOT NULL,
	`distillery_id` text,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`region` text,
	`age_years` integer,
	`abv` real,
	`cask_types` text,
	`mash_bill` text,
	`msrp` real,
	`avg_price` real,
	`description` text,
	`flavor_profile` text,
	`image_url` text,
	`status` text DEFAULT 'verified' NOT NULL,
	`submitted_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`distillery_id`) REFERENCES `distilleries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bottles_category_idx` ON `bottles` (`category`);--> statement-breakpoint
CREATE INDEX `bottles_name_idx` ON `bottles` (`name`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_session_idx` ON `chat_messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_sessions_user_idx` ON `chat_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `distilleries` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`country` text NOT NULL,
	`region` text,
	`founded` integer,
	`description` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`bottle_id` text NOT NULL,
	`pairing_type` text NOT NULL,
	`suggestion` text NOT NULL,
	`rationale` text,
	`source` text DEFAULT 'ai' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pairings_bottle_idx` ON `pairings` (`bottle_id`);--> statement-breakpoint
CREATE TABLE `pours` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bottle_id` text NOT NULL,
	`user_bottle_id` text,
	`rating` real,
	`serving_style` text,
	`amount_ml` integer,
	`context` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_bottle_id`) REFERENCES `user_bottles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pours_user_idx` ON `pours` (`user_id`);--> statement-breakpoint
CREATE INDEX `pours_bottle_idx` ON `pours` (`bottle_id`);--> statement-breakpoint
CREATE TABLE `price_history` (
	`id` text PRIMARY KEY NOT NULL,
	`bottle_id` text NOT NULL,
	`date` integer NOT NULL,
	`price` real NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `price_history_bottle_idx` ON `price_history` (`bottle_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `tasting_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`pour_id` text NOT NULL,
	`nose` text,
	`palate` text,
	`finish` text,
	`freeform` text,
	`flavor_tags` text,
	`extracted_by` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pour_id`) REFERENCES `pours`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasting_notes_pour_id_unique` ON `tasting_notes` (`pour_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `user_bottles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bottle_id` text NOT NULL,
	`relationship` text NOT NULL,
	`status` text,
	`fill_level` integer,
	`quantity` integer DEFAULT 1 NOT NULL,
	`purchase_price` real,
	`purchase_date` integer,
	`store` text,
	`est_value` real,
	`location` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_bottles_user_bottle_uq` ON `user_bottles` (`user_id`,`bottle_id`);--> statement-breakpoint
CREATE INDEX `user_bottles_user_idx` ON `user_bottles` (`user_id`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

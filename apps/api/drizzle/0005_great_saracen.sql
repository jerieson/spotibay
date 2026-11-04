CREATE TYPE "public"."queue_item_source" AS ENUM('user', 'autoplay');--> statement-breakpoint
ALTER TABLE "queue_items" ADD COLUMN "source" "queue_item_source" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "autoplay" boolean DEFAULT false NOT NULL;
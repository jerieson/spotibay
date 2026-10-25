CREATE TABLE "catalog_matches" (
	"catalog_id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "catalog_id" text;--> statement-breakpoint
ALTER TABLE "catalog_matches" ADD CONSTRAINT "catalog_matches_video_id_tracks_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."tracks"("video_id") ON DELETE no action ON UPDATE no action;
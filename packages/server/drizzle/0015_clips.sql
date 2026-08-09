ALTER TABLE "screenshots" ADD COLUMN "format" text DEFAULT 'jpeg' NOT NULL;--> statement-breakpoint
ALTER TABLE "screenshots" ADD COLUMN "frame_count" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "clips_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "sessions" ADD COLUMN "cuts" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cut_seconds" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "video_units" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "original_video_r2_key" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "video_copy_aligned" boolean;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "recompile_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_edit_compile_at" timestamp with time zone;

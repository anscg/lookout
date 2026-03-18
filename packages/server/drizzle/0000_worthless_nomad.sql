CREATE TYPE "public"."session_status" AS ENUM('pending', 'active', 'paused', 'stopped', 'compiling', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "screenshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"minute_bucket" integer NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"width" integer,
	"height" integer,
	"file_size_bytes" integer,
	"sampled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"status" "session_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"last_screenshot_at" timestamp with time zone,
	"resumed_at" timestamp with time zone,
	"total_active_seconds" integer DEFAULT 0 NOT NULL,
	"video_url" text,
	"video_r2_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_screenshots_session_id" ON "screenshots" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_screenshots_session_bucket" ON "screenshots" USING btree ("session_id","minute_bucket");--> statement-breakpoint
CREATE INDEX "idx_screenshots_unconfirmed" ON "screenshots" USING btree ("session_id") WHERE confirmed = false;--> statement-breakpoint
CREATE INDEX "idx_sessions_status" ON "sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sessions_active_last_screenshot" ON "sessions" USING btree ("last_screenshot_at") WHERE status IN ('active', 'paused');
-- One-shot sheets shown in the desktop app. Sibling of `announcements`, with
-- rich content and an audience rule the client evaluates.
--
-- Hand-written with IF NOT EXISTS, as 0028 explains: the drizzle meta snapshot
-- has drifted behind schema.ts, so this has to be correct on both fresh and
-- already-migrated databases.
DO $$ BEGIN
	CREATE TYPE "public"."tip_trigger" AS ENUM('any', 'deep_link');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"badge" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"image_url" text,
	"program" text,
	"trigger" "tip_trigger" DEFAULT 'any' NOT NULL,
	"require_unlinked" boolean DEFAULT false NOT NULL,
	"min_version" text,
	"max_version" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tips_active_updated" ON "tips" ("active", "updated_at" DESC);

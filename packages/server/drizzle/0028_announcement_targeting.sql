-- Announcement targeting: optional inclusive version bounds matched against
-- the client-reported version on GET /api/announcement (absent report = 0).
--
-- IF NOT EXISTS throughout: the drizzle meta snapshot had drifted behind
-- schema.ts (pair_url/start_url/panel_url/panel_resolved_at/view_url were
-- added by earlier hand-written migrations without snapshot updates), so the
-- generator re-emitted them here. On databases that already ran those
-- migrations the plain ALTERs would fail; IF NOT EXISTS makes this file
-- correct on both fresh and existing databases.
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "min_version" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "max_version" text;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "pair_url" text;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "start_url" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "panel_url" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "panel_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "view_url" text;

-- Clips become the default capture mode; programs opt OUT with clips:false.
--
-- Only the DEFAULT changes. Existing rows are deliberately left alone: a
-- session's capture character is immutable by design, so flipping in-flight
-- sessions would change what a running recorder is expected to upload.
ALTER TABLE "sessions" ALTER COLUMN "clips_enabled" SET DEFAULT true;

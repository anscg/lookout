-- Program panel: an https URL the recording client renders in-app (an iframe
-- in a sheet) when the timelapse finishes, instead of sending the user out to
-- the browser via redirect_url. Set at creation, immutable thereafter.
--
-- Hand-written rather than generated, for the reason given in 0023: the
-- drizzle snapshots lag the hand-written migrations from 0018 on.
ALTER TABLE "sessions" ADD COLUMN "panel_url" text;

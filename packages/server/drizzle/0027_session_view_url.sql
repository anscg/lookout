-- The program's own page for this session (its permalink), surfaced to the
-- user as an "Open in <Program>" action on the session view.
--
-- Mutable, unlike redirect_url and panel_url: the target usually does not
-- exist when the session is created — the published timelapse, the submission
-- record — so programs set it afterwards.
--
-- Hand-written rather than generated, for the reason given in 0023.
ALTER TABLE "sessions" ADD COLUMN "view_url" text;

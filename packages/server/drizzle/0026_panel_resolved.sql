-- When the program confirmed it has what its panel was asking for. The user
-- may answer a panel in the app's sheet OR on the program's own website, and
-- the client can see inside neither — so the program declares it, and until it
-- does the client keeps offering the panel on the session page.
--
-- Hand-written rather than generated, for the reason given in 0023.
ALTER TABLE "sessions" ADD COLUMN "panel_resolved_at" timestamp with time zone;

-- Persist the confirm's `final: true`. The server already credits the flush
-- capture its exact partial minute (creditFinalCapture) but then dropped the
-- flag, so the compiler couldn't tell a partial minute from a whole one and
-- gave it a full second of video anyway.
--
-- IF NOT EXISTS as 0028 explains: the drizzle meta snapshot has drifted, so
-- this has to be right on fresh and already-migrated databases both. No
-- backfill — nothing in an old row identifies the flush.
ALTER TABLE "screenshots" ADD COLUMN IF NOT EXISTS "is_final" boolean DEFAULT false NOT NULL;

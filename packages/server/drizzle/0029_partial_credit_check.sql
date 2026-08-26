-- Final captures (pause/stop flush) credit the EXACT partial minute —
-- creditFinalCapture writes any value in [0, 60], not just the all-or-
-- nothing 0/60 the original credit-mode constraint allowed. The old CHECK
-- made every partial-credit confirm fail its UPDATE with a 500: the client
-- retried the 500 through its backoff ladder until the flush budget
-- expired, so every mid-minute pause lost its seconds (the "paused at 0:13,
-- got 0:00 after 10s" bug — diagnosed live against staging, where the
-- confirm 500ed on `credited_seconds = 35`).
ALTER TABLE "screenshots" DROP CONSTRAINT IF EXISTS "chk_screenshots_credited_seconds";--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "chk_screenshots_credited_seconds" CHECK (credited_seconds IS NULL OR (credited_seconds >= 0 AND credited_seconds <= 60));

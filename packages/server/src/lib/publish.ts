import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";

/**
 * Publish a held session by pointing it at its already-built UNCUT
 * original — the "no edits" outcome of an edit hold.
 *
 * A held session finished compiling but deliberately stayed `stopped` with
 * `video_r2_key` null so that programs never observe `complete` before the
 * user's cuts are baked in. This flips it to `complete` with no worker
 * round-trip (the bytes already exist in R2), which is why "Save without
 * edits" and hold expiry are both instant.
 *
 * Atomic and idempotent: the guard means a racing caller (the user's
 * finalize vs. the expiry job) publishes exactly once; the loser gets
 * `false` and should treat the session as already published.
 */
export async function publishHeldSession(sessionId: string): Promise<boolean> {
  const publicDomain = process.env.R2_PUBLIC_DOMAIN || "";

  const [row] = await db
    .select({ originalVideoR2Key: schema.sessions.originalVideoR2Key })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId));
  if (!row?.originalVideoR2Key) return false;

  const [updated] = await db
    .update(schema.sessions)
    .set({
      status: "complete",
      videoR2Key: row.originalVideoR2Key,
      videoUrl: publicDomain
        ? `https://${publicDomain}/${row.originalVideoR2Key}`
        : row.originalVideoR2Key,
      editHoldUntil: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        eq(schema.sessions.status, "stopped"),
        isNotNull(schema.sessions.originalVideoR2Key),
      ),
    )
    .returning({ id: schema.sessions.id });

  return Boolean(updated);
}
